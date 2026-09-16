import { assertSafeOutboundUrl, configureOutboundUrlGuard, ssrfFetch } from '../../../src/core/util/ssrfGuard';

afterEach(() => {
  configureOutboundUrlGuard({ allowedHosts: [], blockedHosts: [] });
});

describe('assertSafeOutboundUrl', () => {
  it('rejects private, loopback, and link-local literals', async () => {
    await expect(assertSafeOutboundUrl('http://10.0.0.1/')).rejects.toThrow(/blocked/);
    await expect(assertSafeOutboundUrl('http://192.168.1.1/')).rejects.toThrow(/blocked/);
    await expect(assertSafeOutboundUrl('http://127.0.0.1:6379/')).rejects.toThrow(/blocked/);
    await expect(assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/blocked/);
    await expect(assertSafeOutboundUrl('http://[::1]/')).rejects.toThrow(/blocked/);
    await expect(assertSafeOutboundUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow(/blocked/);
  });

  it('rejects non-http(s) and allows a public IPv4 literal', async () => {
    await expect(assertSafeOutboundUrl('file:///etc/passwd')).rejects.toThrow(/http and https/);
    await expect(assertSafeOutboundUrl('https://93.184.216.34/')).resolves.toBeUndefined();
  });

  it('honors allow and block lists', async () => {
    configureOutboundUrlGuard({ allowedHosts: ['localhost'], blockedHosts: ['93.184.216.34'] });
    await expect(assertSafeOutboundUrl('http://localhost:11434/v1')).resolves.toBeUndefined();
    await expect(assertSafeOutboundUrl('https://93.184.216.34/')).rejects.toThrow(/blocked/);
  });
});

describe('ssrfFetch', () => {
  it('does not call fetch for a blocked URL', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(ssrfFetch('http://169.254.169.254/')).rejects.toThrow(/blocked/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
