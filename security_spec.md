# MakeVectorizer Firestore Security Specification (Phase 0)

## 1. Data Invariants
1. **Strict Ownership**: Every document in `projects`, `uploads`, `processingJobs`, `vectorResults`, `upscaleResults`, and `downloadHistory` MUST belong to `request.auth.uid` (`userId == request.auth.uid`) and require `request.auth.token.email_verified == true`.
2. **PII Isolation**: `users/{userId}` contains user email and profile metadata; `get` is strictly limited to `request.auth.uid == userId`, and `list` is completely disabled (`if false`).
3. **Referential Integrity**: Documents in `uploads`, `processingJobs`, `vectorResults`, `upscaleResults`, and `downloadHistory` MUST reference an existing `projectId` in `/projects/{projectId}` whose `userId == request.auth.uid`.
4. **Immutable Ownership & Timestamps**: `userId`, `projectId`, and `createdAt` cannot be modified after creation. All `createdAt` and `updatedAt` timestamps must match `request.time`.
5. **Privilege Escalation Prevention**: Users cannot assign or upgrade their own `plan` to `pro` or `business` directly from the client; `users/{userId}` creation restricts `plan == 'free'` and updates disallow mutating `plan` or `uid`.
6. **Terminal State Locking**: Once a `processingJobs/{jobId}` reaches `'completed'`, `'failed'`, or `'cancelled'`, clients cannot reopen or mutate it.
7. **Size & Type Bounds**: Every document ID must match `^[a-zA-Z0-9_-]{1,128}$`, and every string field is strictly length-bounded to prevent storage abuse.

## 2. The "Dirty Dozen" Attack Payloads
1. **Unauthenticated Project Read**: Anonymous caller attempts `get` on `/projects/proj_1`. Must return `PERMISSION_DENIED`.
2. **Cross-User Project Read**: Authenticated User B attempts `get` or `list` on User A's `/projects/proj_a`. Must return `PERMISSION_DENIED`.
3. **Blanket List Query Scraping**: Authenticated User B executes `list` on `/projects` without `where('userId', '==', uidB)`. Must return `PERMISSION_DENIED`.
4. **User PII Enumeration**: Authenticated User B attempts `get` or `list` on `/users/uid_a`. Must return `PERMISSION_DENIED`.
5. **Self-Upgrade Plan Escalation**: User A creates `/users/uid_a` with `plan: "business"` or updates `plan` from `"free"` to `"pro"`. Must return `PERMISSION_DENIED`.
6. **Shadow Ghost Field Injection**: User A creates `/projects/proj_1` with an undeclared field `isVerified: true` or `adminOverride: true`. Must return `PERMISSION_DENIED`.
7. **Identity Spoofing on Create**: User B creates `/projects/proj_spoof` with `userId: "uid_a"`. Must return `PERMISSION_DENIED`.
8. **Orphaned Upload Creation**: User A creates `/uploads/up_1` referencing a non-existent `projectId: "nonexistent"` or User B's `projectId`. Must return `PERMISSION_DENIED`.
9. **ID Poisoning Attack**: User A attempts to create `/projects/` with a 500-character junk ID containing slashes/spaces. Must return `PERMISSION_DENIED`.
10. **Timestamp Backdating**: User A creates `/projects/proj_1` with a forged past `createdAt` instead of `request.time`. Must return `PERMISSION_DENIED`.
11. **Terminal Job Reopening**: User A attempts to update `/processingJobs/job_1` from `status: "completed"` back to `status: "waiting"`. Must return `PERMISSION_DENIED`.
12. **Unverified Email Write**: Authenticated user with `email_verified: false` attempts to write to `/projects/proj_1`. Must return `PERMISSION_DENIED`.
