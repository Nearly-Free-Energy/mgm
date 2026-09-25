import { redirect } from "next/navigation";

/**
 * /review — legacy pilot-review landing (Release 1, issue #3).
 *
 * The pilot bill-review surface was replaced by the management dashboard.
 * Old bookmarks redirect here instead of 404ing.
 */
export default function ReviewRedirect() {
  redirect("/");
}
