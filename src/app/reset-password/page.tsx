import { redirect } from "next/navigation";

/**
 * /reset-password — where password-reset emails used to land. MGM has no
 * passwords (RFC #186), so links from earlier reset emails go on to sign-in
 * by email link. Their token is not used: the redirect drops the URL's
 * query and fragment.
 */
export default function ResetPasswordPage(): never {
  redirect("/login");
}
