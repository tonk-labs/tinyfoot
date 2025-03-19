import B2 from 'backblaze-b2';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export interface BackblazeStorageOptions {
  enabled: boolean;
  applicationKeyId: string;
  applicationKey: string;
  bucketId: string;
  bucketName: string;
  syncInterval?: number; // in milliseconds, defaults to 5 minutes
  maxRetries?: number;
  tempDir?: string;
}

export interface StorageMiddlewareOptions {
  backblaze?: BackblazeStorageOptions;
}

interface UploadUrlResponse {
  uploadUrl: string;
  authorizationToken: string;
}

export class StorageMiddleware {
  private options: StorageMiddlewareOptions;
  private b2Client: B2 | null = null;
  private uploadUrlCache: UploadUrlResponse | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private documentCache: Map<string, Buffer> = new Map();
  private tempDir: string;
  private log: (
    color: 'green' | 'red' | 'blue' | 'yellow',
    message: string,
  ) => void;
  private verbose: boolean;
  private initialized: boolean = false;

  constructor(
    options: StorageMiddlewareOptions,
    logFunction: (
      color: 'green' | 'red' | 'blue' | 'yellow',
      message: string,
    ) => void,
    verbose: boolean = true,
  ) {
    this.options = options;
    this.log = logFunction;
    this.verbose = verbose;
    this.tempDir =
      options.backblaze?.tempDir ||
      path.join(os.tmpdir(), 'tonk-backblaze-sync');

    // Create temp directory if it doesn't exist
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, {recursive: true});
    }

    // Initialize Backblaze client if enabled
    this.initBackblazeClient();
  }

  private async initBackblazeClient(): Promise<void> {
    const backblaze = this.options.backblaze;

    if (!backblaze || !backblaze.enabled) {
      this.initialized = true;
      return;
    }

    try {
      this.b2Client = new B2({
        applicationKeyId: backblaze.applicationKeyId,
        applicationKey: backblaze.applicationKey,
      });

      // Authenticate when initializing
      try {
        await this.b2Client.authorize();
        this.log('green', 'Backblaze B2 client authenticated successfully');

        // Load all documents from Backblaze
        await this.loadDocumentsFromBackblaze();

        // Start sync timer
        this.startSyncTimer();

        this.initialized = true;
      } catch (error) {
        this.log(
          'red',
          `Failed to authenticate with Backblaze B2: ${(error as Error).message}`,
        );
        this.b2Client = null;
        this.initialized = true;
      }
    } catch (error) {
      this.log('red', `Error initializing Backblaze B2 client: ${error}`);
      this.b2Client = null;
      this.initialized = true;
    }
  }

  private startSyncTimer(): void {
    if (!this.options.backblaze?.enabled || this.syncTimer) {
      return;
    }

    const syncInterval = this.options.backblaze.syncInterval || 5 * 60 * 1000; // Default: 5 minutes

    this.syncTimer = setInterval(() => {
      this.syncDocumentsToBackblaze().catch(error => {
        this.log('red', `Sync to Backblaze failed: ${error.message}`);
      });
    }, syncInterval);
  }

  private stopSyncTimer(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  // Handle WebSocket message to capture document data
  public handleMessage(message: Buffer): void {
    try {
      // Try to parse the message to see if it contains document data
      const data = JSON.parse(message.toString());

      // Check if this is an Automerge document message
      if (data.docId && data.changes) {
        // Store the latest document state
        this.documentCache.set(data.docId, message);

        if (this.verbose) {
          this.log('blue', `Cached document: ${data.docId}`);
        }
      }
    } catch (error) {
      // Not a JSON message or doesn't contain the expected fields
      // This is normal for binary messages or other protocols
    }
  }

  // Get upload URL from Backblaze (with caching)
  private async getUploadUrl(): Promise<UploadUrlResponse> {
    if (!this.b2Client) {
      throw new Error('Backblaze client not initialized');
    }

    if (this.uploadUrlCache) {
      return this.uploadUrlCache;
    }

    try {
      const response = await this.b2Client.getUploadUrl({
        bucketId: this.options.backblaze!.bucketId,
      });

      this.uploadUrlCache = response.data;
      return this.uploadUrlCache!;
    } catch (error) {
      // If we get an auth error, try to re-authenticate
      if (
        (error as Error).message.includes('unauthorized') ||
        (error as Error).message.includes('expired')
      ) {
        await this.b2Client.authorize();

        // Try again after re-auth
        const response = await this.b2Client.getUploadUrl({
          bucketId: this.options.backblaze!.bucketId,
        });

        this.uploadUrlCache = response.data;
        return this.uploadUrlCache!;
      }

      throw error;
    }
  }

  // Upload a document to Backblaze
  private async uploadDocument(docId: string, data: Buffer): Promise<void> {
    if (!this.b2Client) {
      throw new Error('Backblaze client not initialized');
    }

    try {
      // Get upload URL
      const uploadUrl = await this.getUploadUrl();

      // Create a content hash (SHA1 is required by Backblaze)
      const contentHash = crypto.createHash('sha1').update(data).digest('hex');

      // Write to temporary file
      const tempFilePath = path.join(this.tempDir, `${docId}.json`);
      fs.writeFileSync(tempFilePath, data);

      // Upload file
      await this.b2Client.uploadFile({
        uploadUrl: uploadUrl.uploadUrl,
        uploadAuthToken: uploadUrl.authorizationToken,
        fileName: `documents/${docId}.json`,
        data: fs.readFileSync(tempFilePath),
        hash: contentHash,
      });

      // Clean up temp file
      fs.unlinkSync(tempFilePath);

      this.log('green', `Document ${docId} uploaded to Backblaze B2`);
    } catch (error) {
      // Invalidate upload URL cache on error
      this.uploadUrlCache = null;

      // Re-throw error for handling
      throw error;
    }
  }

  // Sync all cached documents to Backblaze
  public async syncDocumentsToBackblaze(): Promise<void> {
    if (!this.options.backblaze?.enabled || !this.b2Client) {
      return;
    }

    if (this.documentCache.size === 0) {
      if (this.verbose) {
        this.log('blue', 'No documents to sync to Backblaze');
      }
      return;
    }

    this.log(
      'blue',
      `Syncing ${this.documentCache.size} documents to Backblaze B2...`,
    );

    const promises: Promise<void>[] = [];
    const maxRetries = this.options.backblaze.maxRetries || 3;

    for (const [docId, data] of this.documentCache.entries()) {
      const uploadWithRetry = async () => {
        let retries = 0;

        while (retries < maxRetries) {
          try {
            await this.uploadDocument(docId, data);
            return;
          } catch (error) {
            retries++;

            if (retries >= maxRetries) {
              this.log(
                'red',
                `Failed to upload document ${docId} after ${maxRetries} attempts: ${(error as Error).message}`,
              );
              throw error;
            }

            // Wait before retrying (exponential backoff)
            const delay = Math.pow(2, retries) * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      };

      promises.push(uploadWithRetry());
    }

    try {
      await Promise.all(promises);
      this.log(
        'green',
        `Successfully synced ${this.documentCache.size} documents to Backblaze B2`,
      );
    } catch (error) {
      this.log(
        'red',
        `Error during document sync: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  // Force an immediate sync
  public async forceSyncToBackblaze(): Promise<void> {
    return this.syncDocumentsToBackblaze();
  }

  // Load documents from Backblaze
  public async loadDocumentsFromBackblaze(): Promise<void> {
    if (!this.options.backblaze?.enabled || !this.b2Client) {
      return;
    }

    try {
      this.log('blue', 'Loading documents from Backblaze B2...');

      // List files in the documents directory
      const response = await this.b2Client.listFileNames({
        bucketId: this.options.backblaze!.bucketId,
        prefix: 'documents/',
        maxFileCount: 1000,
        startFileName: '',
        delimiter: '',
      });

      const files = response.data.files;

      if (files.length === 0) {
        this.log('blue', 'No documents found in Backblaze B2');
        return;
      }

      this.log('blue', `Found ${files.length} documents in Backblaze B2`);

      // Download each document
      for (const file of files) {
        try {
          const fileName = file.fileName;
          const docId = path.basename(fileName, '.json');

          // Download file
          const downloadResponse = await this.b2Client.downloadFileByName({
            bucketName: this.options.backblaze!.bucketName,
            fileName: fileName,
            responseType: 'arraybuffer',
          });

          // Store in cache
          const buffer = Buffer.from(downloadResponse.data);
          this.documentCache.set(docId, buffer);

          if (this.verbose) {
            this.log('green', `Loaded document ${docId} from Backblaze B2`);
          }
        } catch (error) {
          this.log(
            'red',
            `Error downloading document ${file.fileName}: ${(error as Error).message}`,
          );
        }
      }

      this.log(
        'green',
        `Successfully loaded ${this.documentCache.size} documents from Backblaze B2`,
      );
    } catch (error) {
      this.log(
        'red',
        `Error loading documents from Backblaze: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  // Get document from cache
  public getDocument(docId: string): Buffer | null {
    return this.documentCache.get(docId) || null;
  }

  // Get all document IDs
  public getAllDocumentIds(): string[] {
    return Array.from(this.documentCache.keys());
  }

  // Check if initialization is complete
  public isInitialized(): boolean {
    return this.initialized;
  }

  // Clean up resources on shutdown
  public async shutdown(): Promise<void> {
    this.stopSyncTimer();

    // Force final sync before shutdown
    if (this.documentCache.size > 0) {
      try {
        await this.syncDocumentsToBackblaze();
      } catch (error) {
        this.log(
          'red',
          `Final sync failed during shutdown: ${(error as Error).message}`,
        );
      }
    }
  }
}
