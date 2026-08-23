import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cdnForAddress, ipv4InCidr } from "./cdn";

describe("ipv4InCidr", () => {
  it("matches inside the block and rejects outside it", () => {
    assert.equal(ipv4InCidr("10.0.0.5", "10.0.0.0/24"), true);
    assert.equal(ipv4InCidr("10.0.1.5", "10.0.0.0/24"), false);
  });

  it("handles the block edges", () => {
    assert.equal(ipv4InCidr("172.64.0.0", "172.64.0.0/13"), true);
    assert.equal(ipv4InCidr("172.71.255.255", "172.64.0.0/13"), true);
    assert.equal(ipv4InCidr("172.72.0.0", "172.64.0.0/13"), false);
    assert.equal(ipv4InCidr("172.63.255.255", "172.64.0.0/13"), false);
  });

  it("handles /32 and /0 without overflowing the mask shift", () => {
    assert.equal(ipv4InCidr("1.2.3.4", "1.2.3.4/32"), true);
    assert.equal(ipv4InCidr("1.2.3.5", "1.2.3.4/32"), false);
    assert.equal(ipv4InCidr("203.0.113.1", "0.0.0.0/0"), true);
  });

  it("handles addresses above the signed 32-bit boundary", () => {
    // 224+ addresses go negative under `<<` without the `>>> 0` correction.
    assert.equal(ipv4InCidr("240.0.0.1", "240.0.0.0/8"), true);
    assert.equal(ipv4InCidr("198.41.200.1", "198.41.128.0/17"), true);
  });

  it("rejects malformed input rather than guessing", () => {
    for (const [ip, cidr] of [
      ["not-an-ip", "10.0.0.0/8"],
      ["10.0.0.1", "10.0.0.0"],
      ["10.0.0.1", "10.0.0.0/33"],
      ["10.0.0.256", "10.0.0.0/8"],
      ["10.0.0.01", "10.0.0.0/8"],
      ["10.0.0", "10.0.0.0/8"]
    ] as const) {
      assert.equal(ipv4InCidr(ip, cidr), false, `${ip} in ${cidr}`);
    }
  });
});

describe("cdnForAddress", () => {
  it("recognizes Cloudflare edge addresses", () => {
    // 172.67.148.151 is the address that produced a real Error 1000.
    for (const ip of ["172.67.148.151", "104.16.0.1", "162.159.0.1", "131.0.72.1"]) {
      assert.equal(cdnForAddress(ip), "Cloudflare", ip);
    }
  });

  it("passes ordinary origin addresses through", () => {
    for (const ip of ["203.0.113.10", "1.1.1.1", "8.8.8.8", "192.168.1.10", "172.63.0.1"]) {
      assert.equal(cdnForAddress(ip), null, ip);
    }
  });

  it("returns null for anything that is not an IPv4 address", () => {
    for (const ip of ["", "example.com", "2606:4700::1111"]) {
      assert.equal(cdnForAddress(ip), null, JSON.stringify(ip));
    }
  });
});
