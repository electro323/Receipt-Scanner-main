import {
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
  IonButton,
  IonAlert,
  IonSpinner,
  IonIcon
} from '@ionic/react';
import { cameraOutline } from 'ionicons/icons';
import { useEffect, useState } from 'react';
import { useHistory } from 'react-router-dom';
import './Home.css';
import { getUserHeaders } from '../userIdentity';

type ScanStatus = 'processing' | 'completed' | 'failed' | 'waiting' | 'duplicate_pending';

type ActiveScan = {
  transactionId: string;
  fileName: string;
  fileType: string;
  previewUrl: string;
  status: ScanStatus;
  message: string;
  receiptData?: any;
  filePath?: string;
  duplicateWarning?: string;
  error?: string;
};

const ACTIVE_SCANS_KEY = 'activeReceiptScans';

const Home: React.FC = () => {
  const history = useHistory();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [uploading, setUploading] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('Ready to upload');
  const [activeScans, setActiveScans] = useState<ActiveScan[]>([]);

  const [showAlert, setShowAlert] = useState<boolean>(false);
  const [alertMessage, setAlertMessage] = useState<string>('');
  const [duplicatePrompt, setDuplicatePrompt] = useState<{
    transactionId: string;
    duplicateOfTransactionId: string;
    message: string;
  } | null>(null);

  const saveScans = (scans: ActiveScan[]) => {
    localStorage.setItem(
      ACTIVE_SCANS_KEY,
      JSON.stringify(scans.map((scan) => ({ ...scan, previewUrl: '' }))),
    );
  };

  const setAndStoreScans = (updater: (scans: ActiveScan[]) => ActiveScan[]) => {
    setActiveScans((current) => {
      const next = updater(current);
      saveScans(next);
      return next;
    });
  };

  const updateScan = (transactionId: string, patch: Partial<ActiveScan>) => {
    setAndStoreScans((scans) =>
      scans.map((scan) =>
        scan.transactionId === transactionId ? { ...scan, ...patch } : scan,
      ),
    );
  };

  const buildPreviewUrl = (receipt: any, scan?: ActiveScan) => {
    return receipt?.transactionId
      ? 'http://localhost:3000/receipt/' + receipt.transactionId + '/preview'
      : scan?.previewUrl || '';
  };

  const openReceipt = (scan: ActiveScan) => {
    history.push('/verify-receipt', {
      receiptData: scan.receiptData || null,
      previewUrl: scan.previewUrl || 'http://localhost:3000/receipt/' + scan.transactionId + '/preview',
      fileName: scan.fileName || scan.filePath || 'Saved Receipt',
      fileType: scan.fileType || '',
      transactionId: scan.transactionId,
      duplicateWarning: scan.duplicateWarning || '',
      status: scan.status,
    });
  };

  const removeScan = (transactionId: string) => {
    setAndStoreScans((scans) => scans.filter((scan) => scan.transactionId !== transactionId));
  };

  const startPolling = (id: string) => {
    let attempts = 0;
    const maxAttempts = 120;

    const interval = setInterval(async () => {
      attempts++;

      try {
        const response = await fetch('http://localhost:3000/receipt/' + id);
        const receipt = await response.json();

        if (!receipt || !receipt.transactionId) {
          updateScan(id, {
            status: 'waiting',
            message: 'Waiting for receipt record...',
          });
          return;
        }

        if (receipt.status === 'duplicate_pending') {
          updateScan(id, {
            status: 'duplicate_pending',
            message: receipt.duplicateWarning || 'Duplicate found. Choose Replace or Cancel.',
            duplicateWarning: receipt.duplicateWarning || '',
          });
          return;
        }

        if (receipt.status === 'processing') {
          updateScan(id, {
            status: 'processing',
            message: 'Backend is processing OCR and AI...',
          });
        }

        if (receipt.status === 'completed') {
          clearInterval(interval);

          setAndStoreScans((scans) =>
            scans.map((scan) =>
              scan.transactionId === id
                ? {
                    ...scan,
                    status: 'completed',
                    message: receipt.duplicateWarning
                      ? 'Completed. Older duplicate was replaced.'
                      : 'Completed. Ready to verify.',
                    receiptData: receipt.receiptData,
                    filePath: receipt.filePath,
                    fileName: receipt.originalName || scan.fileName,
                    fileType: receipt.mimeType || scan.fileType,
                    previewUrl: buildPreviewUrl(receipt, scan),
                    duplicateWarning: receipt.duplicateWarning || '',
                    error: '',
                  }
                : scan,
            ),
          );
        }

        if (receipt.status === 'failed') {
          clearInterval(interval);

          updateScan(id, {
            status: 'failed',
            message: receipt.error || 'Receipt processing failed.',
            error: receipt.error || 'Receipt processing failed.',
          });
        }

        if (attempts >= maxAttempts) {
          clearInterval(interval);

          updateScan(id, {
            message: 'Still processing. Check History later.',
          });
        }
      } catch (error) {
        console.error('POLLING ERROR:', error);

        if (attempts >= maxAttempts) {
          clearInterval(interval);
          updateScan(id, {
            message: 'Unable to check status. Check History later.',
          });
        }
      }
    }, 3000);
  };

  const replaceDuplicateUpload = async (transactionId: string) => {
    try {
      const response = await fetch('http://localhost:3000/receipt/' + transactionId + '/duplicate/replace', {
        method: 'POST',
      });
      const data = await response.json();

      if (data.success === false) {
        throw new Error(data.message || 'Could not replace duplicate bill.');
      }

      updateScan(transactionId, {
        status: 'processing',
        message: data.message || 'Old bill replaced. Processing started.',
        duplicateWarning: data.message || '',
      });
      setStatusMessage('Duplicate replaced. Processing transaction ' + transactionId + '.');
      startPolling(transactionId);
    } catch (error) {
      console.error('DUPLICATE REPLACE ERROR:', error);
      setAlertMessage('Could not replace the old bill. Please try again.');
      setShowAlert(true);
    } finally {
      setDuplicatePrompt(null);
    }
  };

  const cancelDuplicateUpload = async (transactionId: string) => {
    try {
      await fetch('http://localhost:3000/receipt/' + transactionId + '/duplicate/cancel', {
        method: 'POST',
      });
      removeScan(transactionId);
      setStatusMessage('Duplicate upload cancelled. The old bill was kept.');
    } catch (error) {
      console.error('DUPLICATE CANCEL ERROR:', error);
      setAlertMessage('Could not cancel the duplicate upload. Please try again.');
      setShowAlert(true);
    } finally {
      setDuplicatePrompt(null);
    }
  };

  useEffect(() => {
    const savedScans = JSON.parse(localStorage.getItem(ACTIVE_SCANS_KEY) || '[]');

    if (Array.isArray(savedScans)) {
      setActiveScans(savedScans);
      savedScans
        .filter((scan: ActiveScan) => scan.status === 'processing' || scan.status === 'waiting')
        .forEach((scan: ActiveScan) => startPolling(scan.transactionId));
    }
  }, []);

  const createHeicPreviewUrl = async (file: File) => {
    const formData = new FormData();
    formData.append('receipt', file);

    const response = await fetch('http://localhost:3000/preview/heic', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error('HEIC preview failed');
    }

    const blob = await response.blob();
    return URL.createObjectURL(blob);
  };

  const handleFileChange = async (event: any) => {
    if (event.target.files.length === 0) return;

    const file = event.target.files[0];

    const allowedExtensions = ['jpg', 'jpeg', 'png', 'heic', 'pdf'];
    const fileExtension = file.name.split('.').pop()?.toLowerCase();

    if (!fileExtension || !allowedExtensions.includes(fileExtension)) {
      setSelectedFile(null);
      setPreviewUrl('');
      setAlertMessage('Unsupported file type. Please upload JPG, PNG, HEIC, or PDF.');
      setShowAlert(true);
      setStatusMessage('Unsupported file selected.');
      return;
    }

    const maxSizeMB = 10;
    const fileSizeMB = file.size / (1024 * 1024);

    if (fileSizeMB > maxSizeMB) {
      setSelectedFile(null);
      setPreviewUrl('');
      setAlertMessage('File is too large. Please upload a file smaller than 10MB.');
      setShowAlert(true);
      setStatusMessage('File too large.');
      return;
    }

    setSelectedFile(file);

    if (fileExtension === 'heic') {
      setPreviewUrl('');
      setStatusMessage('Preparing HEIC preview...');

      try {
        const heicPreviewUrl = await createHeicPreviewUrl(file);
        setPreviewUrl(heicPreviewUrl);
        setStatusMessage('Receipt selected. Ready to scan.');
      } catch (error) {
        console.error('HEIC PREVIEW ERROR:', error);
        setAlertMessage('Unable to preview HEIC. Please make sure the backend is running.');
        setShowAlert(true);
        setStatusMessage('HEIC selected. Preview could not be generated.');
      }

      return;
    }

    setPreviewUrl(URL.createObjectURL(file));
    setStatusMessage('Receipt selected. Ready to scan.');
  };

  const handleDrop = (event: any) => {
    event.preventDefault();

    if (event.dataTransfer.files.length === 0) return;

    handleFileChange({
      target: {
        files: event.dataTransfer.files,
      },
    });
  };

  const handleDragOver = (event: any) => {
    event.preventDefault();
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setAlertMessage('Please select a receipt file first.');
      setShowAlert(true);
      return;
    }

    setUploading(true);
    setStatusMessage('Uploading receipt and creating transaction ID...');

    const fileForUpload = selectedFile;
    const filePreviewUrl = previewUrl;
    const formData = new FormData();
    formData.append('receipt', fileForUpload);

    try {
      const response = await fetch('http://localhost:3000/upload', {
        method: 'POST',
        headers: getUserHeaders(),
        body: formData,
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        setAlertMessage(
          data.message || 'Receipt could not be read. Please upload a clearer image.',
        );
        setShowAlert(true);
        setStatusMessage('Receipt could not be read.');
        return;
      }

      if (data.status === 'duplicate_pending') {
        const scan: ActiveScan = {
          transactionId: data.transactionId,
          fileName: fileForUpload.name,
          fileType: fileForUpload.type || '',
          previewUrl: filePreviewUrl,
          status: 'duplicate_pending',
          message: data.message || 'Duplicate found. Choose Replace or Cancel.',
          duplicateWarning: data.message || '',
        };

        setAndStoreScans((scans) => [scan, ...scans]);
        setDuplicatePrompt({
          transactionId: data.transactionId,
          duplicateOfTransactionId: data.duplicateOfTransactionId || '',
          message: data.message || 'This exact bill was already uploaded. Replace the old bill or cancel this upload.',
        });
        setStatusMessage('Duplicate bill detected. Choose Replace or Cancel.');
        setSelectedFile(null);
        setPreviewUrl('');
        return;
      }

      const scan: ActiveScan = {
        transactionId: data.transactionId,
        fileName: fileForUpload.name,
        fileType: fileForUpload.type || '',
        previewUrl: filePreviewUrl,
        status: 'processing',
        message: 'Processing started...',
      };

      setAndStoreScans((scans) => [scan, ...scans]);
      setStatusMessage('Transaction ID: ' + data.transactionId + ' | Processing started.');
      setSelectedFile(null);
      setPreviewUrl('');
      startPolling(data.transactionId);
    } catch (error) {
      console.error('UPLOAD ERROR:', error);

      setAlertMessage('Error connecting to backend.');
      setShowAlert(true);
      setStatusMessage('Something went wrong.');
    } finally {
      setUploading(false);
    }
  };

  const isPdf = selectedFile?.name.toLowerCase().endsWith('.pdf');

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Receipt Scanner</IonTitle>
        </IonToolbar>
      </IonHeader>

      <IonContent className="ion-padding page-bg">
        <div className="app-container">
          <div className="hero-card">
            <div className="app-kicker">Receipt Intelligence Workspace</div>
            <h1 className="hero-title">AI Receipt Scanner</h1>
            <p className="hero-subtitle">
              Upload receipts, track every transaction, verify extracted fields, and export JSON, CSV, Excel, or PDF.
            </p>
            <div className="workflow-strip">
              <span>Upload</span>
              <span>OCR</span>
              <span>AI JSON</span>
              <span>Verify</span>
              <span>Export</span>
            </div>
          </div>

          <div
            className="card upload-box"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
          >
            <div className="section-heading-row">
              <div>
                <p className="section-eyebrow">New transaction</p>
                <h2 className="section-title">Upload Receipt</h2>
              </div>
              <span className="format-pill">JPG PNG HEIC PDF</span>
            </div>

            <input
              id="receipt-upload"
              type="file"
              accept=".jpg,.jpeg,.png,.heic,.pdf"
              onChange={handleFileChange}
              hidden
            />

            <input
              id="receipt-camera-upload"
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFileChange}
              hidden
            />

            <div className="upload-action-row">
              <label htmlFor="receipt-upload" className="custom-upload-btn">
                Choose Receipt
              </label>

              <label htmlFor="receipt-camera-upload" className="custom-upload-btn camera-upload-btn">
                <IonIcon icon={cameraOutline} aria-hidden="true" />
                Camera
              </label>
            </div>

            <p className="selected-file-text">
              {selectedFile ? 'Selected file: ' + selectedFile.name : 'No file selected'}
            </p>

            <p className="drag-text">
              Drop a receipt here or choose JPG, PNG, HEIC, or PDF
            </p>

            {previewUrl && (
              <div className="upload-preview">
                {isPdf ? (
                  <iframe
                    src={previewUrl}
                    title="PDF Preview"
                    className="preview-frame"
                  />
                ) : (
                  <img
                    src={previewUrl}
                    alt="Receipt Preview"
                    className="preview-image"
                  />
                )}
              </div>
            )}

            <IonButton
              expand="block"
              onClick={handleUpload}
              disabled={!selectedFile || uploading}
              className="action-button"
            >
              {uploading ? 'Uploading...' : 'Upload & Scan'}
            </IonButton>

            <IonButton
              expand="block"
              color="medium"
              onClick={() => history.push('/history')}
            >
              View History
            </IonButton>

            <p className="status-text">{statusMessage}</p>
          </div>

          <div className="card processing-section">
            <div className="history-header">
              <h2 className="section-title">Current Uploads</h2>
              {activeScans.some((scan) => scan.status === 'processing' || scan.status === 'waiting') && (
                <IonSpinner name="crescent" />
              )}
            </div>

            {activeScans.length === 0 && (
              <div className="empty-state">
                <h3>No active uploads</h3>
                <p>Uploaded receipts will appear here with live processing status.</p>
              </div>
            )}

            {activeScans.map((scan) => (
              <div className="history-card" key={scan.transactionId}>
                <div>
                  <h3>{scan.fileName}</h3>
                  <p><strong>Transaction ID:</strong> {scan.transactionId}</p>
                  <p><strong>Status:</strong> <span className={'status-pill status-' + scan.status}>{scan.status.toUpperCase()}</span></p>
                  <p className="muted-text">{scan.message}</p>
                  {scan.duplicateWarning && <p className="warning-text">{scan.duplicateWarning}</p>}
                </div>

                <div className="history-actions">
                  {scan.status === 'duplicate_pending' && (
                    <>
                      <IonButton
                        color="warning"
                        onClick={() => replaceDuplicateUpload(scan.transactionId)}
                      >
                        Replace
                      </IonButton>

                      <IonButton
                        color="medium"
                        onClick={() => cancelDuplicateUpload(scan.transactionId)}
                      >
                        Cancel
                      </IonButton>
                    </>
                  )}

                  <IonButton
                    color="primary"
                    disabled={scan.status !== 'completed'}
                    onClick={() => openReceipt(scan)}
                  >
                    Verify
                  </IonButton>

                  <IonButton
                    color="medium"
                    onClick={() => removeScan(scan.transactionId)}
                  >
                    Clear
                  </IonButton>
                </div>
              </div>
            ))}
          </div>

          <IonAlert
            isOpen={showAlert}
            onDidDismiss={() => setShowAlert(false)}
            header="Receipt Scanner"
            message={alertMessage}
            buttons={['OK']}
          />

          <IonAlert
            isOpen={!!duplicatePrompt}
            onDidDismiss={() => setDuplicatePrompt(null)}
            header="Duplicate Bill Found"
            message={duplicatePrompt?.message || ''}
            buttons={[
              {
                text: 'Cancel Upload',
                role: 'cancel',
                handler: () => {
                  if (duplicatePrompt?.transactionId) {
                    void cancelDuplicateUpload(duplicatePrompt.transactionId);
                  }
                },
              },
              {
                text: 'Replace Old Bill',
                role: 'confirm',
                handler: () => {
                  if (duplicatePrompt?.transactionId) {
                    void replaceDuplicateUpload(duplicatePrompt.transactionId);
                  }
                },
              },
            ]}
          />
        </div>
      </IonContent>
    </IonPage>
  );
};

export default Home;
