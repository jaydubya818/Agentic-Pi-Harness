declare module "node-pty" {
  export interface IExitEvent {
    exitCode: number;
    signal?: number;
  }

  export interface IPty {
    pid: number;
    onData(listener: (data: string) => void): void;
    onExit(listener: (event: IExitEvent) => void): void;
    kill(signal?: string): void;
  }

  export function spawn(file: string, args: string[], options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }): IPty;
}
