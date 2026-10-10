// The pinned Vinext CLI forces process.exit(0) immediately after prerendering.
// Allow native build handles to drain on Windows; failures retain their exit code.
if (process.platform === 'win32') {
  const exit = process.exit.bind(process);
  process.exit = (code) => {
    if (code === 0) {
      process.exitCode = 0;
      return;
    }
    return exit(code);
  };
}
