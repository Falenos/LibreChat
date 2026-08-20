import type { Config } from '../config.js';
import type { Metrics } from '../middleware/metrics.js';

export type AdmissionRejection = 'active_requests' | 'input_bytes';

export interface AdmissionLease {
  reserveInputBytes(bytes: number): { rejected: 'input_bytes' } | null;
  release(): void;
}

export class AdmissionController {
  private activeRequests = 0;
  private inputBytes = 0;

  constructor(
    private readonly config: Config['exec'],
    private readonly metrics: Metrics,
  ) {}

  tryAcquireRequest(): AdmissionLease | { rejected: 'active_requests' } {
    if (this.activeRequests >= this.config.maxActiveRequests) {
      this.metrics.admissionRejected.inc({ reason: 'active_requests' });
      return { rejected: 'active_requests' };
    }

    this.activeRequests += 1;
    this.updateGauges();
    let released = false;
    let bytesReserved = false;
    let reservedBytes = 0;
    return {
      reserveInputBytes: (bytes) => {
        if (released) {
          throw new Error('cannot reserve input bytes on a released admission lease');
        }
        if (bytesReserved) {
          throw new Error('input bytes were already reserved for this admission lease');
        }
        if (this.inputBytes + bytes > this.config.maxInflightInputBytes) {
          this.metrics.admissionRejected.inc({ reason: 'input_bytes' });
          return { rejected: 'input_bytes' };
        }
        bytesReserved = true;
        reservedBytes = bytes;
        this.inputBytes += bytes;
        this.updateGauges();
        return null;
      },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.activeRequests -= 1;
        this.inputBytes -= reservedBytes;
        this.updateGauges();
      },
    };
  }

  private updateGauges(): void {
    this.metrics.admissionActive.set(this.activeRequests);
    this.metrics.admissionInputBytes.set(this.inputBytes);
  }
}
