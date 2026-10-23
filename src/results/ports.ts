export interface ResultFiles {
  readonly root: string;
  describe(path: string): { canonical: boolean; inside: boolean; regular: boolean };
  readable(path: string): void;
  read(path: string): string;
  save(taskRunId: string, nodeId: string, nodeRunId: string, text: string): string;
}
