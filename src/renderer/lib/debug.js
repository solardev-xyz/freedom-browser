// Debug logging - outputs to console (visible in App Developer Tools)

export const pushDebug = (message) => {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] ${message}`);
};
