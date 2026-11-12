// Development helper: print the current two-step code for a known secret (demo accounts).
// Usage: node scripts/totp-code.js <BASE32SECRET>
import * as OTPAuth from 'otpauth';

const secret = process.argv[2];
if (!secret) { console.error('Usage: node scripts/totp-code.js <BASE32SECRET>'); process.exit(1); }
const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 });
console.log(totp.generate());
