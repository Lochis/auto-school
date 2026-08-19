/** TOTP code generation (pyotp equivalent, pure JS). */
import * as otpauth from "otpauth";

/** 6-digit / 30s / SHA1 TOTP from a base32 secret. */
export function generateTotp(secret: string): string {
  const clean = secret.trim().replace(/\s+/g, "");
  const totp = new otpauth.TOTP({
    secret: otpauth.Secret.fromBase32(clean),
    digits: 6,
    period: 30,
  });
  return totp.generate();
}
