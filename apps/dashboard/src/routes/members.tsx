import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Link2, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { CopyButton } from "@/components/common/CopyButton";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { PageHeader } from "@/components/common/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { api, apiGet, fetchMe } from "@/lib/api";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { isOwner, ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/roles";
import type {
  Invitation,
  InvitationCreated,
  Me,
  Member
} from "@/lib/types";

function RoleBadge({ role }: { role: string }) {
  const variant =
    role === "owner" ? "default" : role === "admin" ? "secondary" : "outline";
  return <Badge variant={variant}>{ROLE_LABEL[role] ?? role}</Badge>;
}

function InvitationStatusBadge({ status }: { status: Invitation["status"] }) {
  if (status === "pending") return <Badge variant="warning">Pending</Badge>;
  if (status === "accepted") return <Badge variant="success">Accepted</Badge>;
  if (status === "revoked") return <Badge variant="outline">Revoked</Badge>;
  return <Badge variant="destructive">Expired</Badge>;
}

/**
 * Shown after an invitation is created. The link is the only copy — the server
 * keeps a hash — so this dialog is deliberately blunt about that.
 */
function InviteLinkDialog({
  created,
  onClose
}: {
  created: InvitationCreated | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={created !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Invitation link for {created?.invitation.email}</DialogTitle>
          <DialogDescription>
            Copy this link and send it to them yourself. Sohwe does not send
            email. This is the only time the link is shown — if you lose it,
            revoke the invitation and issue a new one.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-2">
          <code className="min-w-0 flex-1 break-all font-mono text-xs">
            {created?.acceptUrl}
          </code>
          <CopyButton text={created?.acceptUrl ?? ""} label="Copy invitation link" />
        </div>
        <p className="text-xs text-muted-foreground">
          Expires {created ? formatDateTime(created.invitation.expiresAt) : ""} · grants
          the {ROLE_LABEL[created?.invitation.role ?? "member"]?.toLowerCase()} role.
        </p>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  onCreated
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (c: InvitationCreated) => void;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");

  const mut = useMutation({
    mutationFn: () =>
      api<InvitationCreated>("/api/invitations", {
        method: "POST",
        body: JSON.stringify({ email: email.trim().toLowerCase(), role })
      }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["invitations"] });
      setEmail("");
      setRole("member");
      onOpenChange(false);
      onCreated(created);
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Could not create invitation");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mut.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Invite a teammate</DialogTitle>
            <DialogDescription>
              Creates a single-use join link valid for 7 days.
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 space-y-3">
            <Field label="Email">
              <Input
                type="email"
                required
                autoComplete="off"
                placeholder="teammate@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Role">
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <p className="text-xs text-muted-foreground">
              {ROLE_DESCRIPTION[role]}
            </p>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mut.isPending || email.trim() === ""}>
              {mut.isPending ? "Creating…" : "Create link"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MembersTable({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<Member | null>(null);
  const owner = isOwner(me);

  const membersQuery = useQuery({
    queryKey: ["members"],
    queryFn: () => apiGet<Member[]>("/api/members")
  });

  const roleMut = useMutation({
    mutationFn: (v: { id: string; role: string }) =>
      api(`/api/members/${v.id}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role: v.role })
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["members"] });
      toast.success("Role updated");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Could not change role");
    }
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => api(`/api/members/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["members"] });
      toast.success("Member removed");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Could not remove member");
    }
  });

  const members = membersQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Members</CardTitle>
        <CardDescription>
          People with access to {me.organization.name}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {membersQuery.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : members.length === 0 ? (
          <EmptyState title="No members" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="font-medium">
                      {m.name ?? m.email}
                      {m.isSelf ? (
                        <span className="ml-2 text-xs text-muted-foreground">you</span>
                      ) : null}
                    </div>
                    {m.name ? (
                      <div className="text-xs text-muted-foreground">{m.email}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {/* Only owners may change roles, and never their own. */}
                    {owner && !m.isSelf ? (
                      <Select
                        value={m.role}
                        onValueChange={(role) => roleMut.mutate({ id: m.id, role })}
                      >
                        <SelectTrigger className="h-8 w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="owner">Owner</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="member">Member</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <RoleBadge role={m.role} />
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatRelativeTime(m.createdAt)}
                  </TableCell>
                  <TableCell>
                    {m.isSelf || (m.role === "owner" && !owner) ? null : (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        title={`Remove ${m.email}`}
                        onClick={() => setRemoving(m)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.email ?? ""}?`}
        description="They lose access immediately and every session they have is signed out. Apps and deployments are unaffected."
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={() => {
          if (removing) removeMut.mutate(removing.id);
          setRemoving(null);
        }}
      />
    </Card>
  );
}

function InvitationsCard() {
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [created, setCreated] = useState<InvitationCreated | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);

  const invitationsQuery = useQuery({
    queryKey: ["invitations"],
    queryFn: () => apiGet<Invitation[]>("/api/invitations")
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => api(`/api/invitations/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["invitations"] });
      toast.success("Invitation revoked");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Could not revoke invitation");
    }
  });

  const invitations = invitationsQuery.data ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Invitations</CardTitle>
          <CardDescription>
            Sohwe does not send email — create a link and pass it on yourself.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setInviteOpen(true)}>
          <UserPlus className="mr-2 h-4 w-4" />
          Invite
        </Button>
      </CardHeader>
      <CardContent>
        {invitationsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : invitations.length === 0 ? (
          <EmptyState
            title="No invitations yet"
            description="Invite a teammate to give them access to this organization."
            action={
              <Button size="sm" onClick={() => setInviteOpen(true)}>
                <UserPlus className="mr-2 h-4 w-4" />
                Invite
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Invited</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="font-medium">{inv.email}</TableCell>
                  <TableCell>
                    <RoleBadge role={inv.role} />
                  </TableCell>
                  <TableCell>
                    <InvitationStatusBadge status={inv.status} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatRelativeTime(inv.createdAt)}
                    {inv.invitedBy ? ` · ${inv.invitedBy.email}` : ""}
                  </TableCell>
                  <TableCell>
                    {inv.status === "pending" ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        title="Revoke invitation"
                        onClick={() => setRevoking(inv)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onCreated={setCreated}
      />
      <InviteLinkDialog created={created} onClose={() => setCreated(null)} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke the invitation for ${revoking?.email ?? ""}?`}
        description="The link stops working immediately. You can issue a new one afterwards."
        confirmLabel="Revoke"
        variant="destructive"
        onConfirm={() => {
          if (revoking) revokeMut.mutate(revoking.id);
          setRevoking(null);
        }}
      />
    </Card>
  );
}

export function MembersPage() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => fetchMe<Me | null>() });
  if (!me) return null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Members"
        description="Who can sign in to this instance, and what they are allowed to do."
      />

      <MembersTable me={me} />

      {/* Members can see the roster but not the invitation machinery. */}
      {isOwner(me) || me.role === "admin" ? <InvitationsCard /> : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What each role can do</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex gap-3">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="font-medium">Owner</p>
              <p className="text-muted-foreground">{ROLE_DESCRIPTION.owner}</p>
            </div>
          </div>
          <div className="flex gap-3">
            <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="font-medium">Admin</p>
              <p className="text-muted-foreground">{ROLE_DESCRIPTION.admin}</p>
            </div>
          </div>
          <div className="flex gap-3">
            <UserPlus className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="font-medium">Member</p>
              <p className="text-muted-foreground">{ROLE_DESCRIPTION.member}</p>
            </div>
          </div>
          <p className="pt-1 text-xs text-muted-foreground">
            Environment variables, the container file browser, backups, and the
            GitHub connection are admin-only, including read access — each one
            can expose an app's secrets.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
