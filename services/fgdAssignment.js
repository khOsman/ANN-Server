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
