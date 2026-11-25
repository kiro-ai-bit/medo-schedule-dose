export interface Metrics {
  incr(name: string, labels?: Record<string, string>, by?: number): void;
}
