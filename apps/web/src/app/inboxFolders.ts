import type { ScreenId } from "@agile-emr/shared";
import { isBuilt } from "./registry";

/** Inbox folders (nav.yaml inbox-folders): role gate and label. Only built folders are shown (NAV-09). */
export interface InboxFolder {
  id: ScreenId;
  label: string;
  roles: string[];
}

export const INBOX_FOLDERS: InboxFolder[] = [
  { id: "inbox.results", label: "Results", roles: ["ma", "provider"] },
  { id: "inbox.rx-requests", label: "Rx requests", roles: ["ma", "provider"] },
  { id: "inbox.cosign", label: "Co-sign", roles: ["provider"] },
  {
    id: "inbox.patient-messages",
    label: "Patient messages",
    roles: ["frontdesk", "ma", "provider", "biller", "manager"],
  },
  {
    id: "inbox.tasks",
    label: "Tasks",
    roles: ["frontdesk", "ma", "provider", "biller", "manager"],
  },
  { id: "inbox.previsit-queue", label: "Pre-visit changes", roles: ["frontdesk", "ma"] },
  { id: "inbox.documents", label: "Documents", roles: ["frontdesk", "ma"] },
  { id: "inbox.prior-auth", label: "Prior auth", roles: ["frontdesk", "ma"] },
  { id: "orders.collection", label: "Specimen collection", roles: ["ma"] },
  { id: "orders.tracking", label: "Overdue orders", roles: ["ma", "provider"] },
  { id: "orders.result-reconciliation", label: "Unmatched results", roles: ["ma", "manager"] },
  { id: "referrals.worklist", label: "Referrals", roles: ["frontdesk"] },
];

export const foldersFor = (role: string) =>
  INBOX_FOLDERS.filter((f) => f.roles.includes(role) && isBuilt(f.id));

/** Where the rail's Inbox item lands: the role's default folder if built, else the first built folder. */
export function inboxLanding(role: string, preferred: ScreenId | null): ScreenId | null {
  if (preferred && isBuilt(preferred)) return preferred;
  return foldersFor(role)[0]?.id ?? null;
}
