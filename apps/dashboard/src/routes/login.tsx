import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, fetchMe } from "@/lib/api";
import { useState } from "react";
import { Shell } from "@/components/common/Shell";
import { toast } from "sonner";
import type { Me } from "@/lib/types";

export function LoginPage() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () => api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      void queryClient.fetchQuery({ queryKey: ["me"], queryFn: () => fetchMe<Me | null>() }).then((m) => {
        if (m) window.location.assign("/apps");
      });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Sign in failed");
    }
  });

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Use the account you created during setup.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              mutation.mutate();
            }}
          >
            <Field label="Email" htmlFor="login-email">
              <Input
                id="login-email"
                name="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password" htmlFor="login-password">
              <Input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {mutation.isError ? (
              <p className="text-sm text-destructive" role="alert">
                {mutation.error instanceof Error ? mutation.error.message : "Something went wrong"}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={mutation.isPending}>
              {mutation.isPending ? "Signing in…" : "Sign in"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Need to finish first-time setup? <Link to="/setup" className="text-primary hover:underline">Open setup</Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </Shell>
  );
}
