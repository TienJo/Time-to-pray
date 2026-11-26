# Firestore Security Specification (Phase 0)

## 1. Data Invariants
1. **Strict Ownership**: Every document under `/users/{userId}/prayer_nodes/{nodeId}` and `/users/{userId}/settings/{settingId}` belongs strictly to `{userId}` (`request.auth.uid == userId`), requires a verified Google account (`request.auth.token.email_verified == true`), and must carry `ownerId == request.auth.uid`.
2. **Immutable Identity & Timestamps**: `id`, `ownerId`, and `createdAt` cannot be modified after creation. `createdAt` (on create) and `updatedAt` (on create & update) must match `request.time`.
3. **Referential Integrity**: A child `PrayerNode` with a non-empty `parentId` can only be created if that parent document exists after the write/batch (`existsAfter`) in the same user's `prayer_nodes` collection.
4. **Strict Field Allowlisting & Bounds**: Unknown shadow fields are rejected (`hasOnly`). All strings enforce `.size()` limits (`title <= 200`, `content <= 5000`, `reference <= 200`), `type` must be in `['anxiety', 'gratitude', 'reflection', 'scripture']`, and `x`/`y` must be finite numbers in `[-50000, 50000]`.
5. **Query Security**: `allow list` enforces `resource.data.ownerId == request.auth.uid` on every queried document without `get()`/`exists()` lookups.

## 2. Dirty Dozen Adversarial Payloads (Must Return PERMISSION_DENIED)
1. Unauthenticated read or write (`request.auth == null`).
2. Unverified token (`email_verified == false`) attempting create/update/list.
3. Cross-user access (`uid = "attacker"` targeting `/users/victim/prayer_nodes/node-1`).
4. Identity spoofing (`ownerId: "victim"` while `auth.uid == "attacker"`).
5. Document ID mismatch (`nodeId = "node-1"` in path, `id: "node-2"` in body).
6. ID poisoning (`nodeId` > 128 chars or containing invalid characters `/../`).
7. Shadow field injection (`{ ..., isAdmin: true }` on create or update).
8. Immortal field mutation (changing `ownerId` or `createdAt` on update).
9. Client-forged timestamp (`createdAt` or `updatedAt` != `request.time`).
10. Orphaned child creation (`parentId: "nonexistent-parent"`).
11. Resource exhaustion / oversized content (`content.size() > 5000` or `title.size() > 200`).
12. Invalid enum or out-of-range coordinate (`type: "admin"` or `x: 999999`).
