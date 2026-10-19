import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Docker from "dockerode";
import { request } from "node:http";
import { promoteProjectHttpContainer } from "./project-docker-ops";

// Explicit opt-in via `pnpm --filter @sohwe/worker test:routing`.
// Uses only disposable containers/networks, no existing Sohwe installation.
test(
  "Traefik refreshes the project route after promotion to the proxy network",
  { timeout: 90_000 },
  async () => {
    const docker = new Docker();
    const suffix = randomUUID().slice(0, 8);
    const networks: Docker.Network[] = [];
    const containers: Docker.Container[] = [];
    async function waitFor<T>(
      read: () => Promise<T>,
      ready: (value: T) => boolean,
    ): Promise<T> {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try {
          const value = await read();
          if (ready(value)) return value;
        } catch {
          /* still starting */
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error("Timed out waiting for the isolated routing fixture");
    }
    try {
      // Explicit unused subnets also work on development machines whose default
      // Docker address pools are exhausted by previous acceptance projects.
      for (let offset = 0; offset < 2; offset++) {
        let created: Docker.Network | undefined;
        for (let index = 100 + offset; index < 250; index += 2) {
          try {
            created = await docker.createNetwork({
              Name: `sohwe-routing-${suffix}-${offset}`,
              Driver: "bridge",
              IPAM: { Config: [{ Subnet: `10.245.${index}.0/24` }] },
            });
            break;
          } catch (error) {
            if ((error as { statusCode?: number }).statusCode !== 403)
              throw error;
          }
        }
        assert.ok(created);
        networks.push(created);
      }
      const privateName = (await networks[0]!.inspect()).Name;
      const proxyName = (await networks[1]!.inspect()).Name;
      const traefik = await docker.createContainer({
        Image: "traefik:v3.7",
        name: `sohwe-routing-${suffix}-proxy`,
        Cmd: [
          "--providers.docker=true",
          "--providers.docker.exposedbydefault=false",
          "--providers.providersThrottleDuration=200ms",
          "--entrypoints.web.address=:80",
          "--api.insecure=true",
        ],
        HostConfig: {
          NetworkMode: proxyName,
          Binds: ["/var/run/docker.sock:/var/run/docker.sock:ro"],
          PortBindings: {
            "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
            "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
          },
        },
      });
      containers.push(traefik);
      await traefik.start();
      const proxy = await traefik.inspect();
      const apiUrl = `http://127.0.0.1:${proxy.NetworkSettings.Ports["8080/tcp"]![0]!.HostPort}`;
      const publicUrl = `http://127.0.0.1:${proxy.NetworkSettings.Ports["80/tcp"]![0]!.HostPort}`;
      const router = `routing${suffix}`;
      const candidate = await docker.createContainer({
        Image: "node:24-bookworm-slim",
        name: `sohwe-routing-${suffix}-candidate`,
        Cmd: [
          "node",
          "-e",
          "require('http').createServer((req,res)=>res.end('routing-ok')).listen(3000,'0.0.0.0')",
        ],
        Labels: {
          "traefik.enable": "true",
          "traefik.docker.network": proxyName,
          [`traefik.http.routers.${router}.rule`]: "Host(`project.test`)",
          [`traefik.http.routers.${router}.entrypoints`]: "web",
          [`traefik.http.services.${router}.loadbalancer.server.port`]: "3000",
        },
        HostConfig: { NetworkMode: privateName },
      });
      containers.push(candidate);
      await candidate.start();
      const privateIp = (await candidate.inspect()).NetworkSettings.Networks[
        privateName
      ]!.IPAddress;
      const readBackend = async () => {
        const response = await fetch(
          `${apiUrl}/api/http/services/${router}@docker`,
          { signal: AbortSignal.timeout(2000) },
        );
        const data = (await response.json()) as {
          loadBalancer?: { servers?: { url: string }[] };
        };
        return data.loadBalancer?.servers?.[0]?.url;
      };
      await waitFor(
        readBackend,
        (value) => value === `http://${privateIp}:3000`,
      );
      // This is the production failure: a healthy candidate is initially cached
      // at its project-private address, unreachable to the proxy.
      const legacy = await candidate.inspect();
      const promoted = await promoteProjectHttpContainer(docker, candidate, {
        name: legacy.Name.slice(1), Image: "node:24-bookworm-slim", Cmd: legacy.Config.Cmd,
        Labels: legacy.Config.Labels, HostConfig: { NetworkMode: privateName },
        NetworkingConfig: { EndpointsConfig: { [privateName]: {}, [proxyName]: {} } }
      });
      containers.push(promoted);
      await promoted.start();
      const info = await promoted.inspect();
      const proxyIp = info.NetworkSettings.Networks[proxyName]!.IPAddress;
      await waitFor(readBackend, (value) => value === `http://${proxyIp}:3000`);
      const response = await waitFor(
        () =>
          new Promise<{ status: number; text: string }>((resolve, reject) => {
            const req = request(
              publicUrl,
              { headers: { Host: "project.test" } },
              (res) => {
                let text = "";
                res.on("data", (chunk) => {
                  text += String(chunk);
                });
                res.on("end", () =>
                  resolve({ status: res.statusCode ?? 0, text }),
                );
              },
            );
            req.setTimeout(2000, () =>
              req.destroy(new Error("fixture request timed out")),
            );
            req.on("error", reject);
            req.end();
          }),
        (value) => value.status === 200,
      );
      assert.equal(response.text, "routing-ok");
      assert.equal(
        info.RestartCount,
        0,
        "an intentional stop/start must not appear as an automatic crash restart",
      );
    } finally {
      for (const container of containers.reverse())
        await container.remove({ force: true, v: true }).catch(() => {});
      for (const network of networks.reverse())
        await network.remove().catch(() => {});
    }
  },
);
