import { StorageClient } from '../../src/storage';

describe('StorageClient', () => {
  let storageClient: StorageClient;
  let mockHttp: any;

  beforeEach(() => {
    mockHttp = {
      post: jest.fn(),
      put: jest.fn(),
      defaults: { baseURL: 'http://localhost:3000' },
    };
    storageClient = new StorageClient(mockHttp);
    jest.clearAllMocks();
  });

  describe('configure', () => {
    it('should set project context', () => {
      expect(() => storageClient.configure('my-project')).not.toThrow();
    });
  });

  describe('upload', () => {
    it('should throw when not configured', async () => {
      const noBaseHttp = { ...mockHttp, defaults: { baseURL: '' } };
      const unconfigured = new StorageClient(noBaseHttp);
      // StorageClient always has http set from constructor, but projectName is undefined
      await expect(unconfigured.upload(Buffer.from('test'), {
        filename: 'test.txt',
        contentType: 'text/plain',
        category: 'documents',
      })).rejects.toThrow('SDK Storage not initialized');
    });

    it('should perform 3-step upload with buffer', async () => {
      storageClient.configure('my-project');

      mockHttp.post
        .mockResolvedValueOnce({ data: { url: '/api/storage/upload-raw/file-1', fileId: 'file-1' } })
        .mockResolvedValueOnce({ data: { success: true } });
      mockHttp.put.mockResolvedValueOnce({ status: 200 });

      const result = await storageClient.upload(Buffer.from('file content'), {
        filename: 'test.txt',
        contentType: 'text/plain',
        category: 'documents',
      });

      expect(mockHttp.post).toHaveBeenCalledTimes(2);
      expect(mockHttp.put).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true });
    });

    it('should return null on upload error', async () => {
      storageClient.configure('my-project');
      mockHttp.post.mockRejectedValue(new Error('Upload failed'));

      const result = await storageClient.upload(Buffer.from('test'), {
        filename: 'test.txt',
        contentType: 'text/plain',
        category: 'docs',
      });

      expect(result).toBeNull();
    });
  });

  describe('signedUrl', () => {
    it('should return download URL', async () => {
      const url = await storageClient.signedUrl('file-123');
      expect(url).toBe('http://localhost:3000/api/storage/file/file-123');
    });
  });

  describe('delete', () => {
    it('should delete file successfully', async () => {
      mockHttp.post.mockResolvedValue({});

      const result = await storageClient.delete('file-123');
      expect(result).toBe(true);
      expect(mockHttp.post).toHaveBeenCalledWith('/api/storage/delete', { fileId: 'file-123' });
    });

    it('should return false on error', async () => {
      mockHttp.post.mockRejectedValue(new Error('Delete failed'));

      const result = await storageClient.delete('file-123');
      expect(result).toBe(false);
    });
  });
});
