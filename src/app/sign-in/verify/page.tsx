import SignInForm from "../sign-in-form";

export default function VerifyPage() {
  return <SignInForm session={null} localEnabled={false} googleEnabled={false} verify />;
}
