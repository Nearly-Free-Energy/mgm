import { redirect } from "next/navigation";

/**
 * /forgot-password — MGM has no passwords (RFC #186): people sign in by
 * email link on /login, which is also how someone who cannot get in starts
 * again. Bookmarks and old links come here and go on to sign-in.
 */
export default function ForgotPasswordPage(): never {
  redirect("/login");
}
