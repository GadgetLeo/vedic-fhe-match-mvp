# FHE Horoscope Match

An Fhenix-powered Vedic compatibility MVP. Users enter profile details and birth data, the browser derives compact chart factors, encrypts those factors with CoFHE, and the Solidity contract computes a compatibility score over encrypted values.

## What Users Enter

- Public: display name, X handle, avatar color, connected wallet.
- Private: birth date, exact birth time, birth city/country, timezone.
- The browser derives moon sign, nakshatra, ascendant, planet signs, relationship house, and Venus/Mars house signals before encryption.

## Scoring

Score is out of `100`:

- Moon sign: `20`
- Nakshatra: `20`
- Ascendant: `10`
- Venus/Mars chemistry: `15`
- Seventh-house overlap: `15`
- Jupiter/Saturn stability: `10`
- Relationship-house overlap: `10`

Reveal tiers:

- Below `70`: no public reveal.
- `70-84`: Strong Match.
- `85-94`: Rare Match.
- `95-100`: Cosmic Match.

## Setup

```bash
npm install
cp .env.example .env
npm test
npm run dev
```

If npm is unavailable, pnpm works too. The current viem release uses a URL-style subdependency, so keep the included `.npmrc` setting when using pnpm.

Deploy to Base Sepolia after setting `BASE_SEPOLIA_RPC_URL` and `PRIVATE_KEY`:

```bash
npx hardhat run scripts/deploy.ts --network baseSepolia
```

Then set `VITE_HOROSCOPE_MATCHER_ADDRESS` to the deployed address and restart the dev server.

Run the automatic matcher worker after profiles exist:

```bash
MATCHER_PRIVATE_KEY=0x... npm run match
```

The matcher scans saved members, skips already-computed pairs, and submits `computeCompatibilityFor(userA,userB)` for sealed profiles.

For a production preview:

```bash
npm run build
npm run preview
```

## Fhenix Integration

- Contract imports `@fhenixprotocol/cofhe-contracts/FHE.sol`.
- Frontend uses `@cofhe/sdk/web`.
- Encrypted inputs are produced with `encryptInputs([...]).execute()`.
- Authorized score viewing uses `decryptForView(...)`.
- Contract grants ACL permissions with `FHE.allowThis`, `FHE.allowSender`, and score-specific `FHE.allow(...)`.

## Match / Reveal Flow

- The frontend no longer shows a real match card while the user is typing.
- `saveProfile` emits a profile update and puts the wallet into the match pool.
- The matcher worker computes encrypted pair scores automatically.
- Connected wallets only load pair records involving their own address.
- A score remains locked until both wallets call `requestReveal`.
- The share card and counterpart identity are shown only after mutual reveal in the UI.

Note: V2 still stores public profile metadata on-chain for compatibility with the MVP contract shape. The UI gates identity display, but true metadata secrecy would require encrypted/off-chain profile metadata.

## Brand Direction

- The app uses the official Fhenix logo from `public/brand/fhenix-logo.svg`.
- The UI palette is based on the Fhenix site: deep navy `#001623`, cyan `#0AD9DC`, light gray `#BCBEBF`, white `#FAFAFA`, and violet `#7585FF`, with small gold accents reserved for the Vedic astrology layer.
