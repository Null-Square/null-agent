/**
 * Prints the link that opens Null AI as you (`npm run link`). It holds the owner key, so open it in
 * your own browser and do not paste it anywhere else.
 */
import { loadOrCreateOwnerKey, ownerKeyFile, ownerLink } from '../src/shared/auth/ownerKey';

const file = ownerKeyFile();
process.stdout.write(`Open this link once in your browser:\n  ${ownerLink(loadOrCreateOwnerKey(file))}\n(key file: ${file})\n`);
