/**
 * Microsoft login selectors. These drift over time — the state machine in
 * teams-login.ts degrades gracefully if one disappears; update here only.
 */
export const SEL = {
  // account entry
  email: 'input[type="email"]',
  password: 'input[type="password"]',
  next: "#idSIButton9", // "Next" / "Sign in" / "Yes" (stay signed in)
  // Microsoft "stay signed in?" prompt (KMSI). The real KMSI page shows BOTH buttons;
  // intermediate processing pages have a disabled #idSIButton9 placeholder.
  staySignedInYes: "#idSIButton9", // "Yes"
  staySignedInNo: "#idBtn_Back", // "No" — present only on real KMSI page
  staySignedInText: [
    "stay signed in",
    "keep you signed in",
    "stay signed in to all your apps",
  ],
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
    // WSO2 / generic IdP MFA wording
    "verification code",
    "one-time password",
  ],

  // Teams app shell — POST-LOGIN-ONLY markers (never present on the /v2/ pre-login
  // landing, which also has #app — do NOT add #app here)
  teamsApp: [
    '#element-for-chat-list',
    '[data-tid="chat-list"]',
    '#chat-list',
    '[data-tid="app-layout-left-rail"]',
  ],

  // --- Centennial myLogin (WSO2 Identity Server, federated school SSO) ---
  // URL marker: /authenticationendpoint/ (e.g. mysso.centennialcollege.ca)
  centennialUser: "#usernameUserInput",
  centennialPassword: "#password",
  centennialSubmit: "#loginForm button[type='submit'], .eds-button--primary",
  centennialError: "#error-msg", // "Authentication Failed! Please Retry"

  // WSO2 MFA option picker ("Select a login option" after "We cannot authenticate")
  authenticatorOption: [
    "button:has-text('authenticator')",
    "a:has-text('authenticator')",
    "[role='button']:has-text('authenticator')",
  ],
  cannotAuthenticateText: ["cannot authenticate your account", "cannot authenticate"],
} as const;

export const MFA_NUMBER_SEL = "#idRichContext_DisplaySign";
