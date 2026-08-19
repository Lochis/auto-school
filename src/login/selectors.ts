/**
 * Microsoft login selectors. These drift over time — the state machine in
 * teams-login.ts degrades gracefully if one disappears; update here only.
 */
export const SEL = {
  // account entry
  email: 'input[type="email"]',
  password: 'input[type="password"]',
  next: "#idSIButton9", // "Next" / "Sign in" / "Yes" (stay signed in)
  staySignedInNo: "#idBtn_Back", // "No" on the stay-signed-in page
  // account picker ("Pick an account") tiles contain the email as text
  accountTile: '[role="option"], [role="button"], [data-test-id]', // fallback: text match on email

  // --- MFA indicators (any one visible => 2FA flow is active) ---
  mfa: [
    "#idTxtBx_SAOTCC_OTC", // "Enter the code" (SMS/email OTP)
    "#idDiv_SAOTCS_Description", // "Verify your identity" panel
    "#idDiv_SAOTCS_TitleMsg", // title variant
    "#idRichContext_DisplaySign", // Authenticator number-matching: the number to match
  ],
  mfaText: [
    "verify your identity",
    "enter the code",
    "approve sign in request",
    "enter the number displayed",
    "approve the request",
  ],

  // Teams app shell (login complete)
  teamsApp: "#app, [data-testid='app'], #element-for-chat-list",
} as const;

export const MFA_NUMBER_SEL = "#idRichContext_DisplaySign";
