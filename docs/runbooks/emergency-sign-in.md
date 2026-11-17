# Emergency sign-in

MGM has no passwords (RFC #186): the only way in is the link that
`/login` emails through the deployment's mail sender (`MGM_SMTP_URL`). If
that sender is down or misconfigured, nobody can sign in, super admins
included. This runbook lets an operator make a sign-in link for **one
super admin** from the command line, so they can get in while the mail
server is fixed.

The link is a credential: whoever opens it is signed in as that person.
Treat every step below as handling a password.

## Who

- **Who may ask:** a super admin, for themselves. Nobody asks for a link
  for someone else.
- **Who runs it:** a maintainer who holds the production service-role key
  (`SUPABASE_SERVICE_ROLE_KEY`).
- **Confirm the requester out of band**, by a call or in person, before
  making the link. Do not take the request by email: the mail path is what
  is broken, and an email asking for access is exactly what an attacker
  would send.

## First, try the normal path

A link from this runbook bypasses the mail server, so use it only when the
sign-in email cannot be fixed quickly.

1. Ask the person to press **Email me a sign-in link** once more, then
   look in the hosting provider's runtime logs for `auth.sign_in_link`:
   - `send_failed` with a setting name: `MGM_SMTP_URL`, `MGM_MAIL_FROM` or
     `MGM_APP_URL` is missing or invalid. Fix it in the hosting
     environment and redeploy.
   - `send_failed` with no setting name: the mail server refused or could
     not be reached. Check its status and credentials.
   - `limited`: wait a minute (1 a minute and 5 an hour per address).
   - `no_access`: the address has no MGM role. This runbook will refuse
     it too.
2. If the email arrives but the link fails, the link was probably opened
   twice, opened after 15 minutes, or replaced by a newer email. Ask for
   one new email and open it once, on the device that will use MGM.

## Make the link

From the repository root, on a machine you control, with Python 3:

```bash
python3 scripts/emergency-sign-in-link.py \
  --supabase-url "https://<project-ref>.supabase.co" \
  --app-url "https://<the installation's MGM_APP_URL>" \
  --email "<the super admin's address>" \
  --requested-by "<name>, confirmed by <call or in person> at <time>" \
  --reason "<why the sign-in email cannot be used>"
```

It asks for the service-role key with a hidden prompt (or reads
`SUPABASE_SERVICE_ROLE_KEY` if it is already set in the shell). Never
put the key on the command line or in a file.

The script:

- refuses an address with no MGM role, and one without a `super_admin`
  role, before asking Supabase Auth for anything, so it never creates an
  account;
- asks Supabase Auth for a one-time token, the same call
  `/api/auth/sign-in-link` makes, and sends no email;
- prints the **record** on standard error and the **link**, alone, on
  standard output.

The link works **once, for 15 minutes**, on the device where it is opened.
Making another link, or the person asking for a sign-in email, cancels it.

## Hand it over

- In person, or over a trusted channel that the person is already signed
  in to, such as a direct message in the team's end-to-end encrypted chat.
- Never by email or SMS, and never in a shared channel, ticket or issue.
- Clear it from your terminal scrollback and clipboard once it is handed
  over.

The person opens it and presses **Continue**. They are signed in like
anyone who used the emailed link.

## Record it

The same day, add the record the script printed (time, operator, address,
user id, who asked and how they were confirmed, and why) to the operations
log in the private operations repository, and tell the second maintainer.
Never record the link itself.

## Afterwards

1. Fix the deployment's mail sender, and check that a normal sign-in email
   arrives and works.
2. If the link may have been seen by anyone else, end every session the
   person has, including any the link opened, in the Supabase SQL editor
   with the user id from the record:

   ```sql
   DELETE FROM auth.sessions WHERE user_id = '<user id>';
   ```

   Their refresh tokens go with the sessions. Access tokens already issued
   stay valid until they expire, at most an hour (`jwt_expiry`). The person
   then signs in again by email.
