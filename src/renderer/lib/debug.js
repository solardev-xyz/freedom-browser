// Debug logging - outputs to console (visible in App Developer Tools)

export const pushDebug = (message) => {
  const isTestEnv =
    typeof process !== 'undefined' &&
    (process.env.NODE_ENV === 'test' || Boolean(process.env.JEST_WORKER_ID));

  if (isTestEnv && !process.env.DEBUG) {
    return;
  }

  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] ${message}`);
};
