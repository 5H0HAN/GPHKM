import { InvitationAcceptance } from "@/components/identity/invitation-acceptance";

export const dynamic = "force-dynamic";

export default function AcceptStaffInvitationPage() {
  return <InvitationAcceptance kind="staff" />;
}
