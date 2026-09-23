// Serialized into the packaged Electron smoke script; keep this function self-contained.
export function observeSmokeOutput(
  outputTail: string,
  chunk: string,
  token: string,
  echoToken?: string,
) {
  const output = outputTail + chunk
  return {
    tail: output.slice(-4096),
    sawToken: output.includes(token),
    sawEcho: echoToken !== undefined && output.includes(echoToken),
  }
}
