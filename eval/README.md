# Label accuracy eval

Measures how accurately the live Muse Spark reader transcribes real medicine
packs, field by field (spec §5.1). Target: 20 packs by Oct 31.

**Bar:** zero confidently-wrong strengths or expiry dates. A field is
*confidently wrong* when its value is wrong while the reader marked it
`clear`. A field marked `unreadable` is never confidently wrong.

## Privacy

Everything under `eval/packs/` is git-ignored. Photos, pack identities and
read text stay on your machine. The script writes **aggregate counts only** to
`docs/eval-results.md`; that file is the only output meant to be committed.

## Adding a pack

1. Create a folder `eval/packs/<pack-id>/`, e.g. `eval/packs/pack-01/`.
2. Put 1 to 3 photos of the pack in it (JPEG, PNG or WebP, max 8 MB each), the
   same shots a user would take: front, back, the side with the expiry.
3. Write `eval/packs/<pack-id>/truth.json` from what is printed on the pack:

```json
{
  "packId": "pack-01",
  "images": ["front.jpg", "back.jpg"],
  "brandName": "Biogesic",
  "genericNames": ["Paracetamol"],
  "strength": "500 mg",
  "dosageForm": "Tablet",
  "registrationNumber": "DR-XY12345",
  "expiryDate": "03/2027"
}
```

- `images`: file names inside the pack folder, in reading order.
- `genericNames`: one entry per active ingredient.
- `strength`: as printed, and it must parse (`500 mg`, `250 mg/5 mL`,
  `500 mg/125 mg`). The script rejects a truth file whose strength it cannot
  parse.
- `registrationNumber`, `expiryDate`: use `null` when the pack does not print
  one. Expiry is compared by month and year; `MM/YYYY`, `MM-YYYY`, `YYYY-MM`
  and `MON YYYY` are accepted, with or without `EXP`.

## How fields are compared

| Field | Rule |
| --- | --- |
| brandName | equal after name normalisation (case, ®/™, form words ignored) |
| genericNames | same set of normalised names (`A + B` equals `B, A`) |
| strength | same parsed strengths after unit conversion (`1 g` = `1000 mg`); unparseable read = incorrect |
| dosageForm | same canonical form (`Film-coated tablets` = `tablet`; `eye drops` ≠ `ear drops`) |
| registrationNumber | equal after registration-number normalisation |
| expiryDate | same month and year |

A `null` truth is correct when the read is `null` or `unreadable`.

## Running

The script calls the real Meta Model API and costs money. It stops before the
next pack once `DAILY_SPEND_CAP_USD` (default 5) is reached.

```sh
MODEL_API_KEY=... npm run eval:labels -w @medilens/server
```

It prints a per-field table and every confidently-wrong case (pack id, field,
read value) to the terminal, then writes `docs/eval-results.md`. With no packs
it prints `No packs found` and writes nothing. Exit code 2 means the bar was
missed.

Each pack is validated and normalised exactly as live uploads are, but the
photo-quality gate is not applied: the eval measures the reader itself.
