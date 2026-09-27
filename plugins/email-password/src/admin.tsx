/**
 * Admin React components for the email-password auth provider.
 *
 * Exposed via the descriptor's `adminEntry`. EmDash's admin UI imports this
 * module statically (virtual module) and pulls `LoginForm` and `SetupStep`
 * from it. The two components are independent — `LoginForm` is the standard
 * login form for existing users, `SetupStep` is the first-admin form used
 * when the site hasn't been initialised yet.
 *
 * Both forms POST JSON to the route handlers shipped with this plugin and
 * render inline error / success messages; they do NOT navigate the page.
 * The handler redirects on success, so a navigation happens once.
 */

import { useState, type FormEvent, type JSX } from "react";

const LOGIN_ENDPOINT = "/_emdash/api/auth/email-password/login";
const SETUP_ENDPOINT = "/_emdash/api/auth/email-password/setup";

interface ErrorResponse {
  error?: { code?: string; message?: string };
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; redirect: string | null; error: string | null }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // 2xx: handler redirected with a relative URL (admin login → admin).
    if (res.redirected) return { ok: true, redirect: res.url, error: null };
    if (res.ok) {
      // Some setups return 200 with a redirect target in the body.
      const data = (await res.json().catch(() => null)) as
        | { redirect?: string }
        | null;
      if (data?.redirect) return { ok: true, redirect: data.redirect, error: null };
      return { ok: true, redirect: null, error: null };
    }

    const payload = (await res.json().catch(() => null)) as ErrorResponse | null;
    const code = payload?.error?.code;
    const message = payload?.error?.message;
    return {
      ok: false,
      redirect: null,
      error: message ?? humaniseErrorCode(code, res.status),
    };
  } catch {
    return { ok: false, redirect: null, error: "Network error — please try again." };
  }
}

function humaniseErrorCode(code: string | undefined, status: number): string {
  if (code === "rate_limited") return "Too many attempts. Please wait a minute and try again.";
  if (code === "invalid_credentials") return "Invalid email or password.";
  if (code === "user_not_found") return "Invalid email or password.";
  if (code === "setup_already_complete") return "An admin account already exists.";
  if (code === "weak_password") return "Please choose a stronger password.";
  if (code === "invalid_email") return "Please enter a valid email address.";
  if (code === "validation_failed") return "Some fields are missing or invalid.";
  if (status === 503) return "Authentication is temporarily unavailable.";
  return "Something went wrong. Please try again.";
}

const sharedInputClass =
  "block w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-muted)] focus:border-[var(--color-brand)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-ring)] disabled:opacity-50";

const sharedButtonClass =
  "inline-flex w-full items-center justify-center gap-2 rounded-md border border-transparent bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-[var(--color-on-brand)] hover:bg-[var(--color-brand-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-ring)] focus:ring-offset-2 disabled:opacity-50";

const sharedErrorClass =
  "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200";

const loginButtonClass =
  "flex w-full items-center justify-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-ring)] focus:ring-offset-2 disabled:opacity-50";

/**
 * Compact button rendered on the login page's provider grid. The admin
 * wrapper handles the click (sets `activeProvider`), so this component
 * just renders the visual; it ignores any click events that bubble up
 * from inside it.
 *
 * The `inviteToken` prop is forwarded for invite-accept flows. The plugin
 * doesn't support invite-token binding (credentials are stored per-user,
 * not per-token), so we accept the prop but don't use it.
 */
export function LoginButton(_props: { inviteToken?: string }): JSX.Element {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      className={loginButtonClass}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
        aria-hidden
      >
        <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      <span>Sign in with email &amp; password</span>
    </button>
  );
}

/**
 * Email + password login form. Used on the standard login page once at
 * least one admin exists. Posts to `/_emdash/api/auth/email-password/login`.
 */
export function LoginForm(): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await postJson(LOGIN_ENDPOINT, { email, password });
    setSubmitting(false);
    if (result.ok) {
      window.location.href = result.redirect ?? "/_emdash/admin";
      return;
    }
    setError(result.error);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      <div className="space-y-1">
        <label
          htmlFor="email-password-email"
          className="block text-sm font-medium text-[var(--color-text)]"
        >
          Email
        </label>
        <input
          id="email-password-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
          disabled={submitting}
          className={sharedInputClass}
        />
      </div>
      <div className="space-y-1">
        <label
          htmlFor="email-password-password"
          className="block text-sm font-medium text-[var(--color-text)]"
        >
          Password
        </label>
        <input
          id="email-password-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          disabled={submitting}
          className={sharedInputClass}
        />
      </div>
      {error ? <p className={sharedErrorClass}>{error}</p> : null}
      <button type="submit" disabled={submitting} className={sharedButtonClass}>
        {submitting ? "Signing in…" : "Sign in with email"}
      </button>
    </form>
  );
}

/**
 * First-admin setup step. Rendered as one of the options on the setup
 * wizard's "Create admin account" step. Posts to
 * `/_emdash/api/auth/email-password/setup`. The `onComplete` callback is
 * fired when the setup flow has run; the wizard decides what to do next.
 */
export function SetupStep({ onComplete }: { onComplete: () => void }): JSX.Element {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await postJson(SETUP_ENDPOINT, { name, email, password });
    setSubmitting(false);
    if (result.ok) {
      onComplete();
      return;
    }
    setError(result.error);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      <p className="text-sm text-[var(--color-text-secondary)]">
        Create the first admin account. You'll use this email and password to
        sign in afterward.
      </p>
      <div className="space-y-1">
        <label
          htmlFor="email-password-setup-name"
          className="block text-sm font-medium text-[var(--color-text)]"
        >
          Display name
        </label>
        <input
          id="email-password-setup-name"
          name="name"
          type="text"
          autoComplete="name"
          required
          minLength={1}
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          disabled={submitting}
          className={sharedInputClass}
        />
      </div>
      <div className="space-y-1">
        <label
          htmlFor="email-password-setup-email"
          className="block text-sm font-medium text-[var(--color-text)]"
        >
          Email
        </label>
        <input
          id="email-password-setup-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
          disabled={submitting}
          className={sharedInputClass}
        />
      </div>
      <div className="space-y-1">
        <label
          htmlFor="email-password-setup-password"
          className="block text-sm font-medium text-[var(--color-text)]"
        >
          Password
        </label>
        <input
          id="email-password-setup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          disabled={submitting}
          className={sharedInputClass}
        />
        <p className="text-xs text-[var(--color-muted)]">
          Minimum 12 characters with at least one letter and one digit or symbol.
        </p>
      </div>
      {error ? <p className={sharedErrorClass}>{error}</p> : null}
      <button type="submit" disabled={submitting} className={sharedButtonClass}>
        {submitting ? "Creating account…" : "Create admin account"}
      </button>
    </form>
  );
}
