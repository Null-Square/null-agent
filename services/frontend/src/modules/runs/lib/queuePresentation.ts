export const queuedReasonLabel = (reason: string | null | undefined): string => {
  if (reason === 'waiting_for_plan_slot') {
    return 'Waiting for an available run slot.';
  }
  if (reason === 'preparing_secure_environment') {
    return 'Capacity is reserved and this assessment is being prepared.';
  }
  if (reason === 'launch_recovered') {
    return 'Safely re-queued after launch recovery.';
  }
  if (reason === 'unable_to_schedule_safely') {
    return 'This assessment cannot be scheduled safely with the available capacity.';
  }
  return 'Waiting for available capacity. It will start automatically.';
};
