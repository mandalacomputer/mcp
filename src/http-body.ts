import type { IncomingMessage } from 'node:http';
import { Transform, type TransformCallback } from 'node:stream';

/** A parser input that admits each chunk before the parser can retain it. */
export class MeteredBody extends Transform {
  readonly headers;
  readonly socket;
  complete = false;

  constructor(
    private readonly request: IncomingMessage,
    private readonly admit: (bytes: number) => boolean,
    private readonly refused: () => void,
  ) {
    super();
    // body-parser needs these IncomingMessage fields for media type, charset,
    // and completion checks. The socket stays owned by the original request.
    this.headers = request.headers;
    this.socket = request.socket;
    request.once('aborted', this.aborted);
    request.once('error', this.failed);
    request.pipe(this);
  }

  private readonly aborted = () => {
    this.destroy(Object.assign(new Error('request aborted'), { type: 'request.aborted' }));
  };

  private readonly failed = (error: Error) => {
    this.destroy(error);
  };

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    if (this.admit(chunk.length)) {
      done(null, chunk);
      return;
    }
    this.refused();
    done(new Error('Large request body capacity exhausted'));
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.complete = true;
    this.request.unpipe(this);
    this.request.off('aborted', this.aborted);
    this.request.off('error', this.failed);
    // Destroy only the parser input: its reader releases retained chunks while
    // the original request drains without buffering or resetting the 503.
    this.request.resume();
    done(error);
  }
}
