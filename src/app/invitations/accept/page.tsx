import { InvitationAcceptance } from "@/components/identity/invitation-acceptance";

export const dynamic = "force-dynamic";

export default function AcceptOrganizationInvitationPage() {
  return <InvitationAcceptance kind="organization" />;
}
