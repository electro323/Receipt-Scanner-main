import {
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
  IonButton,
  IonInput,
  IonItem,
  IonLabel,
  IonAlert,
  IonSpinner,
} from '@ionic/react';
import { useEffect, useState } from 'react';
import { useHistory } from 'react-router-dom';
import './Home.css';
import { getUserHeaders } from '../userIdentity';

const History: React.FC = () => {
  const history = useHistory();

  const [receipts, setReceipts] = useState<any[]>([]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [searchId, setSearchId] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  const [showAlert, setShowAlert] = useState<boolean>(false);
  const [alertMessage, setAlertMessage] = useState<string>('');

  const loadReceipts = async (showLoader = true) => {
    if (showLoader) setLoading(true);

    try {
      const response = await fetch('http://localhost:3000/receipts', {
        headers: getUserHeaders(),
      });
      const data = await response.json();

      if (Array.isArray(data)) {
        setReceipts(data);
      } else {
        setReceipts([]);
      }
    } catch (error) {
      console.error('HISTORY LOAD ERROR:', error);
      if (showLoader) {
        setAlertMessage('Could not load history. Check that the backend is running and try again.');
        setShowAlert(true);
      }
    } finally {
      if (showLoader) setLoading(false);
    }
  };

  const loadAnalytics = async () => {
    try {
      const response = await fetch('http://localhost:3000/analytics/monthly', {
        headers: getUserHeaders(),
      });
      const data = await response.json();

      setAnalytics(data);
    } catch (error) {
      console.error('ANALYTICS LOAD ERROR:', error);
      setAnalytics(null);
    }
  };

  const searchReceipt = async () => {
    if (!searchId.trim()) {
      setAlertMessage('Enter a transaction ID to search.');
      setShowAlert(true);
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(
        `http://localhost:3000/receipt/${searchId.trim()}`
      );

      const data = await response.json();

      if (!data || !data.transactionId) {
        setAlertMessage('No transaction matched that ID.');
        setShowAlert(true);
        return;
      }

      openReceipt(data);
    } catch (error) {
      console.error('SEARCH ERROR:', error);
      setAlertMessage('Search failed. Check your connection and try again.');
      setShowAlert(true);
    } finally {
      setLoading(false);
    }
  };

  const openReceipt = (receipt: any) => {
    history.push('/verify-receipt', {
      receiptData: receipt.receiptData && Object.keys(receipt.receiptData).length > 0 ? receipt.receiptData : null,
      previewUrl: `http://localhost:3000/receipt/${receipt.transactionId}/preview`,
      fileName: receipt.originalName || receipt.filePath || 'Saved Receipt',
      fileType: receipt.mimeType || '',
      transactionId: receipt.transactionId,
      duplicateWarning: receipt.duplicateWarning || '',
      status: receipt.status,
    });
  };

  const downloadJson = (receipt: any) => {
    if (!receipt.receiptData) {
      setAlertMessage('JSON is available after processing is completed.');
      setShowAlert(true);
      return;
    }

    const blob = new Blob([JSON.stringify(receipt.receiptData, null, 2)], {
      type: 'application/json',
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download = `${receipt.transactionId}.json`;
    a.click();

    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    loadReceipts();
    void loadAnalytics();
    const interval = setInterval(() => {
      void loadReceipts(false);
      void loadAnalytics();
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  const getFileName = (receipt: any) => receipt.originalName || receipt.filePath?.split(/[\\/]/).pop() || 'Uploaded bill';

  const formatUploadedAt = (receipt: any) => {
    const value = receipt.createdAt || receipt.updatedAt;
    if (!value) return '-';

    return new Date(value).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatMoney = (value: any) => {
    const amount = Number(value || 0);
    return '₹' + amount.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Receipt History</IonTitle>
        </IonToolbar>
      </IonHeader>

      <IonContent className="ion-padding page-bg">
        <div className="app-container">
          <div className="hero-card">
            <div className="app-kicker">Transaction Archive</div>
            <h1 className="hero-title">Receipt History</h1>
            <p className="hero-subtitle">
              Find transactions, open previews, and review processing status.
            </p>
          </div>

          <div className="card">
            <h2 className="section-title">Search by Transaction ID</h2>

            <IonItem>
              <IonLabel position="stacked">Transaction ID</IonLabel>
              <IonInput
                value={searchId}
                placeholder="Example: TXN-1782364961653"
                onIonInput={(e) => setSearchId(String(e.detail.value || ''))}
              />
            </IonItem>

            <IonButton
              expand="block"
              onClick={searchReceipt}
              className="action-button"
            >
              Search Receipt
            </IonButton>
          </div>

          <div className="card analytics-card">
            <div className="history-header">
              <div>
                <p className="section-eyebrow">Monthly analytics</p>
                <h2 className="section-title recent-title">
                  Spending by Category
                </h2>
              </div>
              <div className="analytics-total">
                <span>{analytics?.month || 'This month'}</span>
                <strong>{formatMoney(analytics?.total || 0)}</strong>
              </div>
            </div>

            {!analytics || analytics.categories?.length === 0 ? (
              <div className="empty-state table-empty">
                <h3>No spending data yet</h3>
                <p>Completed receipts from this month will appear here.</p>
              </div>
            ) : (
              <div className="analytics-grid">
                {analytics.categories.map((row: any) => (
                  <div className="analytics-row" key={row.category}>
                    <div className="analytics-row-top">
                      <strong>{row.category}</strong>
                      <span>{formatMoney(row.total)}</span>
                    </div>
                    <div className="analytics-bar-track">
                      <div
                        className="analytics-bar"
                        style={{ width: Math.max(4, Math.min(100, Number(row.percentage || 0))) + '%' }}
                      />
                    </div>
                    <div className="analytics-meta">
                      {row.count} entries · {row.percentage}%
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card history-table-card">
            <div className="history-header">
              <h2 className="section-title recent-title">Recent Uploads</h2>

              <div className="history-refresh-actions">
                <span className="auto-refresh-text">Auto refresh on</span>
                <IonButton color="medium" onClick={() => loadReceipts(true)}>
                  Refresh
                </IonButton>
              </div>
            </div>

            {loading && <IonSpinner name="crescent" />}

            {!loading && receipts.length === 0 && (
              <div className="empty-state table-empty">
                <h3>No receipts yet</h3>
                <p>Upload a bill to create your first transaction.</p>
              </div>
            )}

            {!loading && receipts.length > 0 && (
              <div className="recent-table-wrap">
                <table className="recent-upload-table">
                  <thead>
                    <tr>
                      <th>File Name</th>
                      <th>Transaction ID</th>
                      <th>Status</th>
                      <th>Uploaded At</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receipts.map((receipt: any) => (
                      <tr key={receipt.transactionId}>
                        <td className="file-name-cell">{getFileName(receipt)}</td>
                        <td className="transaction-cell">{receipt.transactionId}</td>
                        <td>
                          <span className={'status-pill status-' + receipt.status}>
                            {String(receipt.status || 'queued').toUpperCase()}
                          </span>
                        </td>
                        <td>{formatUploadedAt(receipt)}</td>
                        <td>
                          <IonButton
                            fill="outline"
                            size="small"
                            onClick={() => openReceipt(receipt)}
                          >
                            VIEW
                          </IonButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <IonButton
            expand="block"
            color="medium"
            onClick={() => history.push('/')}
          >
            Back to Upload
          </IonButton>

          <IonAlert
            isOpen={showAlert}
            onDidDismiss={() => setShowAlert(false)}
            header="Receipt History"
            message={alertMessage}
            buttons={['OK']}
          />
        </div>
      </IonContent>
    </IonPage>
  );
};

export default History;
