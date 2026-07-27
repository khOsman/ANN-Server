import { COLLECTIONS } from "../constants/collections.js";

export const FGD_ROSTER_CAP = 3;

// Shared by the admin assign-fgd endpoint and the selection committee's
// self-service slot booking — both need the exact same denormalized merge
// onto the champion doc and the FGD doc, just with different surrounding
// checks (and only one of them sends a notification email).
export function buildFgdAssignmentUpdates({ championId, champion, fgdId, fgd }) {
  const assignedFgdsById = new Map(
    (champion.assigned_fgds || []).map((item) => [item.fgd_id, item])
  );

  assignedFgdsById.set(fgdId, {
    fgd_id: fgdId,
    fgd_code: fgd.fgd_code || "",
    fgd_name: fgd.fgd_name || "",
    cohort_name: fgd.cohort_name || "",
    session_date: fgd.session_date || "",
    session_start_time: fgd.session_start_time || "",
    session_end_time: fgd.session_end_time || "",
    venue: fgd.venue || "",
    meet_link: fgd.meet_link || "",
  });

  const assignedFgds = Array.from(assignedFgdsById.values());
  const assignedFgdIds = assignedFgds.map((item) => item.fgd_id);

  const committeeMembersById = new Map(
    (fgd.committee_members || []).map((item) => [item.champion_id, item])
  );

  committeeMembersById.set(championId, {
    champion_id: championId,
    name: champion.name || "",
    email: champion.email || "",
  });

  return {
    championUpdates: {
      assigned_fgd_ids: assignedFgdIds,
      assigned_fgds: assignedFgds,
      assigned_fgd_count: assignedFgdIds.length,
    },
    fgdUpdates: {
      committee_members: Array.from(committeeMembersById.values()),
    },
  };
}

// A champion's name/email are denormalized onto the committee_members[]
// entry of every FGD they're assigned to (see buildFgdAssignmentUpdates
// above) — no Firestore triggers exist here to keep those copies in sync,
// so a profile edit that actually changes one of those fields has to fan
// out to each assigned FGD explicitly.
export async function syncChampionAcrossAssignedFgds({
  db,
  FieldValue,
  championId,
  assignedFgdIds,
  fields,
}) {
  if (!assignedFgdIds?.length || !fields || Object.keys(fields).length === 0) {
    return;
  }

  await Promise.all(
    assignedFgdIds.map(async (fgdId) => {
      const fgdRef = db.collection(COLLECTIONS.FGDS).doc(fgdId);
      const snap = await fgdRef.get();

      if (!snap.exists) return;

      const fgd = snap.data();
      const committeeMembers = (fgd.committee_members || []).map((member) =>
        member.champion_id === championId ? { ...member, ...fields } : member
      );

      await fgdRef.update({
        committee_members: committeeMembers,
        updated_at: FieldValue.serverTimestamp(),
      });
    })
  );
}
