// Read a pasted sign-in link. Pure, so it's unit-tested.
//
// Why: an iPhone Home Screen web app has its own storage, separate from Safari,
// and email links always open in Safari — so tapping the link signs Safari in,
// not the Home Screen app. Copying the link (long-press → Copy Link) and pasting
// it into the app instead lets the app use the link's one-time token itself.
//
// Accepts:
//   - the emailed link: https://<project>.supabase.co/auth/v1/verify?token=<hash>&type=magiclink&redirect_to=…
//     -> { tokenHash, type } for supabase.auth.verifyOtp({ token_hash, type })
//     (the client's default "implicit" flow puts the token hash straight in the link)
//   - the app URL Safari lands on after a sign-in: https://<app>/#access_token=…&refresh_token=…
//     -> { accessToken, refreshToken } for supabase.auth.setSession(...)
// Returns null when the text holds neither.

const OTP_TYPES = ["magiclink", "signup", "email", "invite"];

export function parseSignInLink(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch (e) { return null; }

  // A session in the fragment (or query) of the page the link redirected to.
  const frag = new URLSearchParams(u.hash.replace(/^#/, ""));
  const at = frag.get("access_token") || u.searchParams.get("access_token");
  const rt = frag.get("refresh_token") || u.searchParams.get("refresh_token");
  if (at && rt) return { accessToken: at, refreshToken: rt };

  const token = u.searchParams.get("token") || u.searchParams.get("token_hash");
  if (!token) return null;
  // A PKCE-flow token ("pkce_…") can't be verified this way — it needs the
  // browser that asked for the email. This app uses the implicit flow, so it
  // shouldn't see one; say so rather than fail obscurely.
  if (/^pkce_/.test(token)) return { error: "pkce" };
  const t = String(u.searchParams.get("type") || "").toLowerCase();
  return { tokenHash: token, type: OTP_TYPES.indexOf(t) > -1 ? t : "magiclink" };
}
