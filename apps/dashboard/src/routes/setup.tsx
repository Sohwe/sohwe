import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useState } from "react";
import { Shell } from "@/components/common/Shell";
import { toast } from "sonner";

export function SetupPage() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      api("/api/setup", {
        method: "POST",
        body: JSON.stringify({ email, password, name, organizationName })
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["setup", "status"] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      window.location.assign("/login");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Setup failed");
    }
  });

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>Welcome to Sohwe</CardTitle>
          <CardDescription>Create the first organization and owner account for this instance.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              mutation.mutate();
            }}
          >
            <Field label="Organization name" htmlFor="org">
              <Input id="org" name="organizationName" autoComplete="organization" required value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} />
            </Field>
            <Field label="Your name" htmlFor="name">
              <Input id="name" name="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Email" htmlFor="email">
              <Input id="email" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
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
              {mutation.isPending ? "Creating…" : "Complete setup"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Already have an account? <Link to="/login" className="text-primary hover:underline">Sign in</Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </Shell>
  );
}
