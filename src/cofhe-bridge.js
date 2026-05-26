/**
 * cofhe-bridge.js
 * ================
 * CoFHE SDK encryption for VedicAutoMatch profile creation.
 * Uses @cofhe/sdk/web to encrypt 8 koota attributes (uint8) + name + xHandle (uint128).
 *
 * Returns 10 encrypted inputs matching the contract's InEuint8/InEuint128 tuple ABI.
 */

import { createCofheConfig, createCofheClient } from '@cofhe/sdk/web';
import { Encryptable } from '@cofhe/sdk';
import { chains } from '@cofhe/sdk/chains';

let _client = null;
let _connected = false;

function getClient() {
  if (!_client) {
    const config = createCofheConfig({ supportedChains: [chains.baseSepolia] });
    _client = createCofheClient(config);
  }
  return _client;
}

/**
 * Connect the CoFHE client to the wallet providers.
 * Must be called once after wallet connect.
 */
export async function connectCofhe(publicClient, walletClient) {
  const client = getClient();
  if (_connected) return client;
  await client.connect(publicClient, walletClient);
  _connected = true;
  return client;
}

/**
 * Encrypt profile inputs: 8 koota attrs (uint8) + name (uint128) + xHandle (uint128).
 *
 * @param {object} kootaAttrs – { varna, vashya, tara, yoni, grahaMaitri, gana, bhakoot, nadi }
 * @param {string} name
 * @param {string} xHandle
 * @returns {Array} 10 encrypted inputs ready to spread into contract.createProfile(...args)
 */
export async function encryptProfileInputs(kootaAttrs, name, xHandle) {
  const client = getClient();

  // Encode name and xHandle to uint128 BigInt values
  const nameBigInt = encodeTextToBigInt(name);
  const xHandleBigInt = encodeTextToBigInt(xHandle);

  const results = await client.encryptInputs([
    Encryptable.uint8(BigInt(kootaAttrs.varna ?? 0)),
    Encryptable.uint8(BigInt(kootaAttrs.vashya ?? 0)),
    Encryptable.uint8(BigInt(kootaAttrs.tara ?? 0)),
    Encryptable.uint8(BigInt(kootaAttrs.yoni ?? 0)),
    Encryptable.uint8(BigInt(kootaAttrs.grahaMaitri ?? 0)),
    Encryptable.uint8(BigInt(kootaAttrs.gana ?? 0)),
    Encryptable.uint8(BigInt(kootaAttrs.bhakoot ?? 0)),
    Encryptable.uint8(BigInt(kootaAttrs.nadi ?? 0)),
    Encryptable.uint128(nameBigInt),
    Encryptable.uint128(xHandleBigInt),
  ]).execute();

  return results;
}

/**
 * Encode a short string to a uint128-safe BigInt (first 15 chars, UTF-8 bytes).
 */
function encodeTextToBigInt(s) {
  const bytes = new TextEncoder().encode(s.slice(0, 15));
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) {
    n = (n << 8n) | BigInt(bytes[i]);
  }
  return n;
}

/**
 * Decode back for display.
 */
export function decodeText(n) {
  const bytes = [];
  let v = n;
  while (v > 0n) {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Summary for UI.
 */
export function encryptedBlobSummary(tuples) {
  return `${tuples.length} encrypted inputs (CoFHE SDK)`;
}

/**
 * No-op — we use structured tuples now, not hex.
 */
export function toHex(_) {
  return null;
}

/**
 * Fetch and decrypt the caller's own profile name + X handle from the contract.
 * Uses the new getMyProfileData() view (returns sealed uint128 ciphertexts).
 * Works across devices because the data lives on-chain (sealed to owner).
 *
 * @param {ethers.Contract} contract - VedicAutoMatch instance
 * @returns {Promise<{name: string, xHandle: string}>}
 */
export async function fetchMyProfileData(contract) {
  try {
    const [nameCt, handleCt] = await contract.getMyProfileData();
    if (!nameCt || !handleCt || (nameCt === 0n && handleCt === 0n)) {
      return { name: "", xHandle: "" };
    }

    const client = getClient();

    // CoFHE SDK decrypt for values already sealed to the connected wallet
    const [nameBigInt, handleBigInt] = await Promise.all([
      client.decrypt(nameCt),
      client.decrypt(handleCt)
    ]);

    return {
      name: decodeText(nameBigInt ?? 0n),
      xHandle: decodeText(handleBigInt ?? 0n)
    };
  } catch (err) {
    console.warn("[fetchMyProfileData] decrypt failed or no profile:", err?.message || err);
    return { name: "", xHandle: "" };
  }
}
