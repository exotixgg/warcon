# EXOTIX timed VIP reservations

This fork adds a narrow `PATCH /api/servers/{serverId}/lists/reserve/entries/{steamId}` operation for timed EXOTIX VIP delivery. It changes one server's own active reserved-slot row. It does not create a row, edit its reason, change an organisation list, or grant a permanent slot. The existing `POST` creates the initial finite row; the existing generic `DELETE` remains available to operators but must not be used by the EXOTIX delivery worker.

The caller needs `slots.manage` on the named server and must use the same WARCON API-key identity that created the reservation. The active row must have a finite expiry and an exact `EXOTIX VIP {uuid}` reason. The caller obtains its last observed expiry from WARCON's server list state and sends it as a precondition. Provider order and payment identifiers remain in the Platform's private records, not in the WARCON reason.

To extend a confirmed paid period, send:

```json
{
  "expectedMarker": "EXOTIX VIP 00000000-0000-4000-8000-000000000000",
  "expectedExpiresAt": "2026-11-12T12:00:00.000Z",
  "expiresAt": "2026-12-12T12:00:00.000Z"
}
```

The new expiry must be finite, at least as late as the expected expiry, and within WARCON's existing ten-year limit. A successful response includes `ok`, `changed`, and the resulting `entry`. Repeating the same request after a lost response returns `changed: false` once that exact expiry is present. Only extend after the next paid-through time has been verified; do not add an automatic extra day.

To withdraw an invalidated entitlement, send the same marker and expected expiry with `"remove": true` instead of `expiresAt`. This soft-removes only the matching active row and syncs the server. A lost-response retry by the same API-key identity can confirm the matching tombstone without removing a replacement. Both operations return `409 reservation_conflict` if the row, expiry, marker, creator, or list has changed; the Platform should stop and reconcile rather than overwrite an operator's entry.

The implementation is confined to the server reservation route, list store, and focused tests. When merging future upstream WARCON updates, retain the route, the creator/marker/expiry compare-and-set checks, the permission-matrix line, and the focused test suite. This document describes a local fork change; enabling EXOTIX's `owned-cas-v1` capability requires a separately verified deployment and readback.
