import {describe, it, expect} from 'vitest';
import {HandlerRegistry} from '../src/worker/handlerRegistry.js';

describe('HandlerRegistry', () => {
  it('should register and retrieve a handler', () => {
    const registry = new HandlerRegistry();
    const handler = async () => 'result';

    registry.register('testJob', handler);

    expect(registry.get('testJob')).toBe(handler);
  });

  it('should throw when getting an unregistered handler', () => {
    const registry = new HandlerRegistry();

    expect(() => registry.get('nonExistent')).toThrow('No handler registered for job: nonExistent');
  });

  it('should throw when registering a non-function', () => {
    const registry = new HandlerRegistry();

    expect(() => registry.register('testJob', 'notAFunction')).toThrow('Handler must be a function');
  });

  it('should return true for registered job names via has()', () => {
    const registry = new HandlerRegistry();
    registry.register('testJob', async () => {});

    expect(registry.has('testJob')).toBe(true);
    expect(registry.has('other')).toBe(false);
  });

  it('should list all registered job names', () => {
    const registry = new HandlerRegistry();
    registry.register('jobA', async () => {});
    registry.register('jobB', async () => {});

    expect(registry.names()).toEqual(['jobA', 'jobB']);
  });
});
