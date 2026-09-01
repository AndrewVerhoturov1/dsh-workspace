export function attachTaskUrl(record, taskUrl) {
  if (!taskUrl) {
    throw new Error("task_url required");
  }

  return {
    ...record,
    task_url: taskUrl,
    state: "TASK_CREATED"
  };
}
