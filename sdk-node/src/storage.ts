import { AxiosInstance } from 'axios';
import * as fs from 'fs';

export class StorageClient {
  private http?: AxiosInstance;
  private projectName?: string;

  constructor(private httpInstance: AxiosInstance) {
    this.http = httpInstance;
  }

  configure(projectName: string) {
    this.projectName = projectName;
  }

  async upload(
    file: Buffer | string,
    options: { filename: string; contentType: string; category: string }
  ): Promise<any> {
    if (!this.http || !this.projectName) {
      throw new Error('SDK Storage not initialized');
    }

    try {
      let fileBuffer: Buffer;
      if (typeof file === 'string') {
        fileBuffer = fs.readFileSync(file);
      } else {
        fileBuffer = file;
      }

      // 1. Get signed upload URL (local upload raw endpoint)
      const { data: uploadInfo } = await this.http.post('/api/storage/upload-url', {
        projectId: this.projectName,
        fileName: options.filename,
        mimeType: options.contentType,
        category: options.category,
      });

      // 2. Perform raw file upload
      const uploadUrl = uploadInfo.url;
      const fileId = uploadInfo.fileId;
      
      await this.http.put(uploadUrl, fileBuffer, {
        headers: { 'Content-Type': options.contentType },
      });

      // 3. Confirm upload
      const { data: confirmInfo } = await this.http.post('/api/storage/confirm', {
        fileId,
        size: fileBuffer.length,
        cdnUrl: `/api/storage/file/${fileId}`,
      });

      return confirmInfo;
    } catch (err: any) {
      console.error('[caps] Storage upload error (silent):', err.message);
      return null;
    }
  }

  async signedUrl(fileId: string, options?: { expiresIn?: number }): Promise<string> {
    if (!this.http) throw new Error('SDK Storage not initialized');
    const baseURL = this.http.defaults.baseURL || '';
    return `${baseURL}/api/storage/file/${fileId}`;
  }

  async delete(fileId: string): Promise<boolean> {
    if (!this.http) return false;
    try {
      await this.http.post('/api/storage/delete', { fileId });
      return true;
    } catch {
      return false;
    }
  }
}
export default StorageClient;
