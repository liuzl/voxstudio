export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const consoleIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};
