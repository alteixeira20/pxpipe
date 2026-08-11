import { describe, expect, it } from 'vitest';
import { countNativeImageBytes, imageByteHeadroom, type TransformInfo } from '../src/core/transform.js';
import type { Message } from '../src/core/types.js';

function info(overrides: Partial<TransformInfo> = {}): TransformInfo {
  return {
    compressed: false, origChars: 0, compressedChars: 0, imageCount: 0,
    imageBytes: 0, staticChars: 0, dynamicChars: 0, dynamicBlockCount: 0,
    droppedChars: 0, ...overrides,
  };
}

describe('decoded image byte budget', () => {
  it('deducts both caller and PXPipe image bytes from one budget', () => {
    expect(imageByteHeadroom(info({ imageBytes: 300, nativeImageBytes: 200 }), 1000)).toBe(500);
    expect(imageByteHeadroom(info({ imageBytes: 900, nativeImageBytes: 200 }), 1000)).toBe(0);
  });

  it('counts caller images at top level and inside tool_result content', () => {
    const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };
    const messages: Message[] = [{
      role: 'user',
      content: [
        image,
        { type: 'tool_result', tool_use_id: 'x', content: [image] },
      ],
    }];
    expect(countNativeImageBytes(messages)).toBe(6); // 4 b64 chars => 3 decoded bytes, twice
  });
});
