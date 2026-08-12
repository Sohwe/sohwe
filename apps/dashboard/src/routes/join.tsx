import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Shell } from "@/components/common/Shell";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, apiGet, fetchMe } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/roles";
import type { InvitationLookup, Me } from "@/lib/types";

/**
 * Redeem an invitation link. Pre-auth: the invitee has no account yet, so the
 * token in the URL is the only credential. The API creates the account and
 * signs them in, which is why this navigates straight to /apps on success.
 */
export function JoinPage() {
  const queryClient = useQueryClient();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  const lookup = useQuery({
    queryKey: ["invitation", token],
    enabled: token !== "",
    retry: false,
    queryFn: () =>
      apiGet<InvitationLookup>(
        `/api/invitations/lookup?token=${encodeURIComponent(token)}`
      )
  });

  const accept = useMutation({
    mutationFn: () =>
      api("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token, name: name.trim(), password })
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      const me = await queryClient.fetchQuery({
        queryKey: ["me"],
        queryFn: () => fetchMe<Me | null>()
      });
      if (me) window.location.assign("/apps");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Could not accept the invitation");
    }
  });

  if (token === "") {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle>Invitation link is incomplete</CardTitle>
            <CardDescription>
              This page needs the full link you were sent, including the token
              after <code>?token=</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" className="w-full">
              <Link to="/login">Go to sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  if (lookup.isPending) {
    return (
      <Shell>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Checking invitation…
          </CardContent>
        </Card>
      </Shell>
    );
  }

  if (lookup.isError) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle>This invitation cannot be used</CardTitle>
            <CardDescription>
              {lookup.error instanceof Error
                ? lookup.error.message
                : "The link is not valid."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" className="w-full">
              <Link to="/login">Go to sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  const inv = lookup.data;

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>Join {inv.organizationName}</CardTitle>
          <CardDescription>
            Creating an account for <strong>{inv.email}</strong> with the{" "}
            {ROLE_LABEL[inv.role]?.toLowerCase() ?? inv.role} role.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              accept.mutate();
            }}
          >
            <Field label="Your name" htmlFor="join-name">
              <Input
                id="join-name"
                name="name"
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Password (at least 8 characters)" htmlFor="join-password">
              <Input
                id="join-password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              {ROLE_DESCRIPTION[inv.role]} This link expires{" "}
              {formatDateTime(inv.expiresAt)}.
            </p>
            <Button
              type="submit"
              className="w-full"
              disabled={accept.isPending || name.trim() === "" || password.length < 8}
            >
              {accept.isPending ? "Creating account…" : "Accept invitation"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </Shell>
  );
}
