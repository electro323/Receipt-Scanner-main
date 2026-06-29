import {
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
  IonButton,
  IonItem,
  IonInput,
  IonLabel,
  IonAlert,
} from '@ionic/react';
import { useEffect, useState } from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import './Home.css';

const VerifyReceipt: React.FC = () => {
  const history = useHistory();
  const location = useLocation<any>();

  const [receipt, setReceipt] = useState<any>(location.state?.receiptData || null);
  const previewUrl = location.state?.previewUrl || '';
  const fileName = location.state?.fileName || 'Uploaded Receipt';
  const transactionId = location.state?.transactionId || '';
  const duplicateWarning = location.state?.duplicateWarning || '';
  const currentStatus = location.state?.status || 'processing';

  const [showAlert, setShowAlert] = useState(false);
  const [alertMessage, setAlertMessage] = useState('');

  useEffect(() => {
    if (duplicateWarning) {
      setAlertMessage(duplicateWarning);
      setShowAlert(true);
    }
  }, [duplicateWarning]);

  if (!receipt) {
    const isPendingPdf = fileName.toLowerCase().endsWith('.pdf');

    return (
      <IonPage>
        <IonHeader>
          <IonToolbar>
            <IonTitle>Verify Receipt</IonTitle>
          </IonToolbar>
        </IonHeader>
        <IonContent className="ion-padding page-bg">
          <div className="app-container">
            <div className="verify-layout">
              <div className="card preview-panel">
                <h2>Bill Preview</h2>
                <p className="selected-file-text">{fileName}</p>
                {previewUrl ? (
                  isPendingPdf ? (
                    <iframe src={previewUrl} title="Receipt PDF" className="verify-preview-frame" />
                  ) : (
                    <img src={previewUrl} alt="Receipt" className="verify-preview-image" />
                  )
                ) : (
                  <p>No preview available.</p>
                )}
              </div>

              <div className="card form-panel">
                <h2>Transaction {String(currentStatus).toUpperCase()}</h2>
                <p className="muted-text">The bill preview is ready. Extracted fields will appear here when processing is complete.</p>
                <IonButton onClick={() => history.push('/history')}>Back to History</IonButton>
              </div>
            </div>
          </div>
        </IonContent>
      </IonPage>
    );
  }

  const isTicket = receipt.document?.type === 'ticket';
  const isTrainTicket = isTicket && receipt.document?.transport_type === 'train';
  const isRefund = receipt.document?.transaction_type === 'refund';
  const isFuelReceipt = receipt.document?.receipt_category === 'fuel' || !!receipt.fuel;
  const documentLabel = isTicket
    ? 'Travel Ticket'
    : isRefund
      ? 'Refund Receipt'
      : isFuelReceipt
        ? 'Fuel Receipt'
        : 'Purchase Receipt';

  const updateField = (section: string, field: string, value: any) => {
    setReceipt((prev: any) => ({
      ...prev,
      [section]: {
        ...prev[section],
        [field]: value,
      },
    }));
  };

  const updateFuelField = (field: string, value: any) => {
    const numericFields = ['quantity', 'rate_per_unit'];

    setReceipt((prev: any) => ({
      ...prev,
      fuel: {
        ...prev.fuel,
        [field]: numericFields.includes(field) ? Number(value) : value,
      },
    }));
  };

  const updateItemField = (index: number, field: string, value: any) => {
    setReceipt((prev: any) => {
      const updatedItems = [...(prev.items || [])];
      const numericFields = ['quantity', 'unit_price', 'total_price', 'refund_amount'];

      updatedItems[index] = {
        ...updatedItems[index],
        [field]: numericFields.includes(field) ? Number(value) : value,
      };

      return {
        ...prev,
        items: updatedItems,
      };
    });
  };

  const updateDiscountField = (index: number, field: string, value: any) => {
    setReceipt((prev: any) => {
      const updatedDiscounts = [...(prev.totals?.discounts || [])];

      updatedDiscounts[index] = {
        ...updatedDiscounts[index],
        [field]: field === 'amount' ? Number(value) : value,
      };

      return {
        ...prev,
        totals: {
          ...prev.totals,
          discounts: updatedDiscounts,
        },
      };
    });
  };

  const addDiscount = () => {
    setReceipt((prev: any) => ({
      ...prev,
      totals: {
        ...prev.totals,
        discounts: [
          ...(prev.totals?.discounts || []),
          { type: 'discount', description: '', amount: 0 },
        ],
      },
    }));
  };

  const deleteDiscount = (index: number) => {
    setReceipt((prev: any) => ({
      ...prev,
      totals: {
        ...prev.totals,
        discounts: (prev.totals?.discounts || []).filter((_: any, i: number) => i !== index),
      },
    }));
  };

  const addItem = () => {
    setReceipt((prev: any) => ({
      ...prev,
      items: [
        ...(prev.items || []),
        isRefund
          ? { name: '', quantity: 1, unit_price: 0, refund_amount: 0, reason: '' }
          : { name: '', quantity: 1, unit_price: 0, total_price: 0, category: '' },
      ],
    }));
  };

  const deleteItem = (index: number) => {
    setReceipt((prev: any) => ({
      ...prev,
      items: (prev.items || []).filter((_: any, i: number) => i !== index),
    }));
  };

  const recalculateTotals = () => {
    setReceipt((prev: any) => {
      if (prev.document?.transaction_type === 'refund') {
        const refundAmount = (prev.items || []).reduce(
          (sum: number, item: any) => sum + Number(item.refund_amount || 0),
          0,
        );
        const discountTotal = (prev.totals?.discounts || []).reduce(
          (sum: number, discount: any) => sum + Number(discount.amount || 0),
          0,
        );
        const finalRefundAmount = Math.max(0, refundAmount - discountTotal);

        return {
          ...prev,
          refund: {
            ...prev.refund,
            refund_amount: finalRefundAmount,
          },
          totals: {
            ...prev.totals,
            subtotal: refundAmount,
            total: finalRefundAmount,
          },
        };
      }

      if (prev.document?.type === 'ticket') {
        const discountTotal = (prev.totals?.discounts || []).reduce(
          (sum: number, discount: any) => sum + Number(discount.amount || 0),
          0,
        );
        const grossTotal = Number(prev.totals?.subtotal || prev.totals?.gross_total || prev.totals?.total || 0);
        const finalTotal = Math.max(0, grossTotal - discountTotal);

        return {
          ...prev,
          totals: {
            ...prev.totals,
            subtotal: grossTotal,
            total: finalTotal,
          },
          payment: {
            ...prev.payment,
            amount: finalTotal,
          },
        };
      }

      if (prev.document?.receipt_category === 'fuel' || prev.fuel) {
        const quantity = Number(prev.fuel?.quantity || 0);
        const ratePerUnit = Number(prev.fuel?.rate_per_unit || 0);
        const discountTotal = (prev.totals?.discounts || []).reduce(
          (sum: number, discount: any) => sum + Number(discount.amount || 0),
          0,
        );
        const grossTotal = quantity * ratePerUnit || Number(prev.totals?.subtotal || prev.totals?.total || 0);
        const total = Math.max(0, grossTotal - discountTotal);

        return {
          ...prev,
          totals: {
            ...prev.totals,
            subtotal: grossTotal,
            total,
          },
          payment: {
            ...prev.payment,
            amount: total,
          },
        };
      }

      const subtotal = (prev.items || []).reduce(
        (sum: number, item: any) => sum + Number(item.total_price || 0),
        0,
      );
      const tax = Number(prev.totals?.tax || 0);
      const discounts = prev.totals?.discounts || [];
      const discountTotal = discounts.reduce(
        (sum: number, discount: any) => sum + Number(discount.amount || 0),
        0,
      );
      const total = subtotal + tax - discountTotal;

      return {
        ...prev,
        totals: {
          ...prev.totals,
          subtotal,
          total,
        },
        payment: {
          ...prev.payment,
          amount: total,
        },
      };
    });
  };

  const saveChanges = async () => {
    if (!transactionId) {
      setAlertMessage('Transaction ID is missing, so changes cannot be saved.');
      setShowAlert(true);
      return;
    }

    try {
      const response = await fetch('http://localhost:3000/receipt/' + transactionId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(receipt),
      });

      if (!response.ok) throw new Error('Save failed');

      const updatedReceipt = await response.json();
      setReceipt(updatedReceipt.receiptData || receipt);
      setAlertMessage('Changes saved successfully.');
      setShowAlert(true);
    } catch (error) {
      console.error('SAVE ERROR:', error);
      setAlertMessage('Could not save changes. Check the backend and try again.');
      setShowAlert(true);
    }
  };

  const downloadFile = async (format: 'json' | 'csv' | 'excel' | 'pdf') => {
    if (!transactionId) {
      setAlertMessage('Transaction ID is missing, so this file cannot be downloaded.');
      setShowAlert(true);
      return;
    }

    try {
      const response = await fetch('http://localhost:3000/receipt/' + transactionId + '/export/' + format);

      if (!response.ok) {
        throw new Error('Download failed');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = transactionId + '.' + (format === 'excel' ? 'xls' : format);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('DOWNLOAD ERROR:', error);
      setAlertMessage('Could not download ' + format.toUpperCase() + '. Try again after processing is complete.');
      setShowAlert(true);
    }
  };

  const downloadJson = () => {
    void downloadFile('json');
  };

  const downloadCsv = () => {
    void downloadFile('csv');
  };

  const downloadExcel = () => {
    void downloadFile('excel');
  };

  const downloadPdf = () => {
    void downloadFile('pdf');
  };

  const isPdf = fileName.toLowerCase().endsWith('.pdf');

  const renderPartyFields = () => {
    const section = isTicket ? 'issuer' : 'vendor';
    const label = isTicket ? 'Issuer' : 'Vendor';
    const party = receipt[section] || {};

    return (
      <>
        <h3>{label} Information</h3>
        <IonItem>
          <IonLabel position="stacked">{label} Name</IonLabel>
          <IonInput value={party.name || ''} onIonInput={(e) => updateField(section, 'name', e.detail.value)} />
        </IonItem>
        <IonItem>
          <IonLabel position="stacked">{label} Address</IonLabel>
          <IonInput value={party.address || ''} onIonInput={(e) => updateField(section, 'address', e.detail.value)} />
        </IonItem>
        {!isFuelReceipt && (
          <IonItem>
            <IonLabel position="stacked">{label} Phone</IonLabel>
            <IonInput value={party.phone || ''} onIonInput={(e) => updateField(section, 'phone', e.detail.value)} />
          </IonItem>
        )}
      </>
    );
  };

  const renderTransactionFields = () => (
    <>
      <h3>Transaction Details</h3>
      <IonItem>
        <IonLabel position="stacked">Date</IonLabel>
        <IonInput value={receipt.transaction?.date || ''} onIonInput={(e) => updateField('transaction', 'date', e.detail.value)} />
      </IonItem>
      <IonItem>
        <IonLabel position="stacked">Time</IonLabel>
        <IonInput value={receipt.transaction?.time || ''} onIonInput={(e) => updateField('transaction', 'time', e.detail.value)} />
      </IonItem>
      {!isTicket && (
        <IonItem>
          <IonLabel position="stacked">Receipt Number</IonLabel>
          <IonInput value={receipt.transaction?.receipt_number || ''} onIonInput={(e) => updateField('transaction', 'receipt_number', e.detail.value)} />
        </IonItem>
      )}
      {isRefund && (
        <IonItem>
          <IonLabel position="stacked">Original Receipt Number</IonLabel>
          <IonInput value={receipt.transaction?.original_receipt_number || ''} onIonInput={(e) => updateField('transaction', 'original_receipt_number', e.detail.value)} />
        </IonItem>
      )}
      <IonItem>
        <IonLabel position="stacked">Currency</IonLabel>
        <IonInput value={receipt.transaction?.currency || ''} onIonInput={(e) => updateField('transaction', 'currency', e.detail.value)} />
      </IonItem>
    </>
  );

  const renderTicketFields = () => (
    <>
      {renderPartyFields()}
      <h3>Travel Details</h3>
      <IonItem>
        <IonLabel position="stacked">Pickup Point</IonLabel>
        <IonInput value={receipt.travel?.pickup_point || ''} onIonInput={(e) => updateField('travel', 'pickup_point', e.detail.value)} />
      </IonItem>
      <IonItem>
        <IonLabel position="stacked">Destination</IonLabel>
        <IonInput value={receipt.travel?.destination || ''} onIonInput={(e) => updateField('travel', 'destination', e.detail.value)} />
      </IonItem>
      {isTrainTicket ? (
        <>
          <IonItem>
            <IonLabel position="stacked">Class</IonLabel>
            <IonInput value={receipt.travel?.class || ''} onIonInput={(e) => updateField('travel', 'class', e.detail.value)} />
          </IonItem>
          <IonItem>
            <IonLabel position="stacked">PNR</IonLabel>
            <IonInput value={receipt.travel?.PNR || ''} onIonInput={(e) => updateField('travel', 'PNR', e.detail.value)} />
          </IonItem>
        </>
      ) : (
        <>
          <IonItem>
            <IonLabel position="stacked">Route</IonLabel>
            <IonInput value={receipt.travel?.route || ''} onIonInput={(e) => updateField('travel', 'route', e.detail.value)} />
          </IonItem>
          <IonItem>
            <IonLabel position="stacked">Ticket Number</IonLabel>
            <IonInput value={receipt.travel?.ticket_number || ''} onIonInput={(e) => updateField('travel', 'ticket_number', e.detail.value)} />
          </IonItem>
        </>
      )}
      {renderTransactionFields()}
      {renderCompactTotals('Fare Before Discount')}
      {renderPaymentFields()}
    </>
  );

  const renderFuelFields = () => (
    <>
      {renderPartyFields()}
      {renderTransactionFields()}
      <h3>Fuel Details</h3>
      <IonItem>
        <IonLabel position="stacked">Product</IonLabel>
        <IonInput value={receipt.fuel?.product || ''} onIonInput={(e) => updateFuelField('product', e.detail.value)} />
      </IonItem>
      <IonItem>
        <IonLabel position="stacked">Quantity</IonLabel>
        <IonInput type="number" value={receipt.fuel?.quantity || 0} onIonInput={(e) => updateFuelField('quantity', e.detail.value)} />
      </IonItem>
      <IonItem>
        <IonLabel position="stacked">Unit</IonLabel>
        <IonInput value={receipt.fuel?.unit || 'Litre'} onIonInput={(e) => updateFuelField('unit', e.detail.value)} />
      </IonItem>
      <IonItem>
        <IonLabel position="stacked">Rate Per Unit</IonLabel>
        <IonInput type="number" value={receipt.fuel?.rate_per_unit || 0} onIonInput={(e) => updateFuelField('rate_per_unit', e.detail.value)} />
      </IonItem>
      {renderCompactTotals('Fuel Amount Before Discount')}
      {renderPaymentFields()}
    </>
  );

  const renderItems = () => (
    <>
      <h3>{isRefund ? 'Refund Items' : 'Items'}</h3>
      <IonButton expand="block" color="medium" onClick={addItem}>+ Add Item</IonButton>
      {(receipt.items || []).map((item: any, index: number) => (
        <div className="item-card" key={index}>
          <div className="item-card-header">
            <h4>Item {index + 1}</h4>
            <IonButton color="danger" size="small" onClick={() => deleteItem(index)}>Delete</IonButton>
          </div>
          <IonItem>
            <IonLabel position="stacked">Name</IonLabel>
            <IonInput value={item.name || ''} onIonInput={(e) => updateItemField(index, 'name', e.detail.value)} />
          </IonItem>
          <IonItem>
            <IonLabel position="stacked">Quantity</IonLabel>
            <IonInput type="number" value={item.quantity || 1} onIonInput={(e) => updateItemField(index, 'quantity', e.detail.value)} />
          </IonItem>
          <IonItem>
            <IonLabel position="stacked">Unit Price</IonLabel>
            <IonInput type="number" value={item.unit_price || 0} onIonInput={(e) => updateItemField(index, 'unit_price', e.detail.value)} />
          </IonItem>
          {isRefund ? (
            <>
              <IonItem>
                <IonLabel position="stacked">Refund Amount</IonLabel>
                <IonInput type="number" value={item.refund_amount || 0} onIonInput={(e) => updateItemField(index, 'refund_amount', e.detail.value)} />
              </IonItem>
              <IonItem>
                <IonLabel position="stacked">Reason</IonLabel>
                <IonInput value={item.reason || ''} onIonInput={(e) => updateItemField(index, 'reason', e.detail.value)} />
              </IonItem>
            </>
          ) : (
            <>
              <IonItem>
                <IonLabel position="stacked">Total Price</IonLabel>
                <IonInput type="number" value={item.total_price || 0} onIonInput={(e) => updateItemField(index, 'total_price', e.detail.value)} />
              </IonItem>
              <IonItem>
                <IonLabel position="stacked">Category</IonLabel>
                <IonInput value={item.category || ''} onIonInput={(e) => updateItemField(index, 'category', e.detail.value)} />
              </IonItem>
            </>
          )}
        </div>
      ))}
    </>
  );

  const renderDiscounts = () => (
    <>
      <h3>Discounts</h3>
      <IonButton expand="block" color="medium" onClick={addDiscount}>+ Add Discount</IonButton>
      {(receipt.totals?.discounts || []).map((discount: any, index: number) => (
        <div className="item-card" key={index}>
          <div className="item-card-header">
            <h4>Discount {index + 1}</h4>
            <IonButton color="danger" size="small" onClick={() => deleteDiscount(index)}>Delete</IonButton>
          </div>
          <IonItem>
            <IonLabel position="stacked">Type</IonLabel>
            <IonInput value={discount.type || ''} onIonInput={(e) => updateDiscountField(index, 'type', e.detail.value)} />
          </IonItem>
          <IonItem>
            <IonLabel position="stacked">Description</IonLabel>
            <IonInput value={discount.description || ''} onIonInput={(e) => updateDiscountField(index, 'description', e.detail.value)} />
          </IonItem>
          <IonItem>
            <IonLabel position="stacked">Amount</IonLabel>
            <IonInput type="number" value={discount.amount || 0} onIonInput={(e) => updateDiscountField(index, 'amount', e.detail.value)} />
          </IonItem>
        </div>
      ))}
    </>
  );

  const renderCompactTotals = (subtotalLabel = 'Amount Before Discount') => (
    <>
      <h3>Totals</h3>
      <IonItem>
        <IonLabel position="stacked">{subtotalLabel}</IonLabel>
        <IonInput type="number" value={receipt.totals?.subtotal || receipt.totals?.total || 0} onIonInput={(e) => updateField('totals', 'subtotal', Number(e.detail.value))} />
      </IonItem>
      {renderDiscounts()}
      <IonItem>
        <IonLabel position="stacked">Final Total</IonLabel>
        <IonInput type="number" value={receipt.totals?.total || 0} onIonInput={(e) => updateField('totals', 'total', Number(e.detail.value))} />
      </IonItem>
    </>
  );

  const renderTotals = () => (
    <>
      <h3>Totals</h3>
      <IonItem>
        <IonLabel position="stacked">Subtotal / Amount Before Discount</IonLabel>
        <IonInput type="number" value={receipt.totals?.subtotal || 0} onIonInput={(e) => updateField('totals', 'subtotal', Number(e.detail.value))} />
      </IonItem>
      <IonItem>
        <IonLabel position="stacked">Tax</IonLabel>
        <IonInput type="number" value={receipt.totals?.tax || 0} onIonInput={(e) => updateField('totals', 'tax', Number(e.detail.value))} />
      </IonItem>
      {renderDiscounts()}
      <IonItem>
        <IonLabel position="stacked">Final Total</IonLabel>
        <IonInput type="number" value={receipt.totals?.total || 0} onIonInput={(e) => updateField('totals', 'total', Number(e.detail.value))} />
      </IonItem>
    </>
  );

  const renderPaymentFields = () => (
    <>
      <h3>Payment</h3>
      <IonItem>
        <IonLabel position="stacked">Payment Method</IonLabel>
        <IonInput value={receipt.payment?.method || ''} onIonInput={(e) => updateField('payment', 'method', e.detail.value)} />
      </IonItem>
      <IonItem>
        <IonLabel position="stacked">Payment Amount</IonLabel>
        <IonInput type="number" value={receipt.payment?.amount || 0} onIonInput={(e) => updateField('payment', 'amount', Number(e.detail.value))} />
      </IonItem>
    </>
  );

  const renderRefundFields = () => (
    <>
      {renderPartyFields()}
      {renderTransactionFields()}
      {renderItems()}
      {renderCompactTotals('Refund Before Discount')}
      <h3>Refund</h3>
      <IonItem>
        <IonLabel position="stacked">Refund Method</IonLabel>
        <IonInput value={receipt.refund?.refund_method || ''} onIonInput={(e) => updateField('refund', 'refund_method', e.detail.value)} />
      </IonItem>
      <IonItem>
        <IonLabel position="stacked">Refund Amount</IonLabel>
        <IonInput type="number" value={receipt.refund?.refund_amount || 0} onIonInput={(e) => updateField('refund', 'refund_amount', Number(e.detail.value))} />
      </IonItem>
    </>
  );

  const renderPurchaseFields = () => (
    <>
      {renderPartyFields()}
      {renderTransactionFields()}
      {renderItems()}
      {renderTotals()}
      {renderPaymentFields()}
    </>
  );

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Verify Receipt</IonTitle>
        </IonToolbar>
      </IonHeader>

      <IonContent className="ion-padding page-bg">
        <div className="verify-top-bar">
          <div>
            <p className="section-eyebrow">Review workspace</p>
            <h1 className="verify-page-title">Verify Extraction</h1>
          </div>
          <IonButton color="medium" onClick={() => history.push('/')}>Back</IonButton>
          <div className="verify-actions">
            <IonButton color="success" onClick={saveChanges}>Save Changes</IonButton>
            <IonButton onClick={downloadJson}>Download JSON</IonButton>
            <IonButton color="tertiary" onClick={downloadCsv}>Download CSV</IonButton>
            <IonButton color="secondary" onClick={downloadExcel}>Download Excel</IonButton>
            <IonButton color="medium" onClick={downloadPdf}>Download PDF</IonButton>
          </div>
        </div>

        <div className="verify-layout">
          <div className="card preview-panel">
            <h2 className="section-title">Receipt Preview</h2>
            <p className="selected-file-text">{fileName}</p>
            {previewUrl ? (
              isPdf ? (
                <iframe src={previewUrl} title="Receipt PDF" className="verify-preview-frame" />
              ) : (
                <img src={previewUrl} alt="Receipt" className="verify-preview-image" />
              )
            ) : (
              <div className="empty-state">
                <h3>No preview available</h3>
                <p>The original file could not be loaded.</p>
              </div>
            )}
          </div>

          <div className="card form-panel">
            <h2 className="section-title">Editable Details</h2>
            <p className="muted-text edit-help">Review the extracted fields, correct anything uncertain, then save before exporting.</p>
            <h3>Document</h3>
            <IonItem>
              <IonLabel position="stacked">Document Type</IonLabel>
              <IonInput value={documentLabel} readonly />
            </IonItem>
            <IonItem>
              <IonLabel position="stacked">Transport Type</IonLabel>
              <IonInput value={receipt.document?.transport_type || ''} onIonInput={(e) => updateField('document', 'transport_type', e.detail.value)} readonly={!isTicket} />
            </IonItem>

            {isTicket ? renderTicketFields() : isRefund ? renderRefundFields() : isFuelReceipt ? renderFuelFields() : renderPurchaseFields()}

            <IonButton expand="block" color="warning" onClick={recalculateTotals}>Recalculate Amounts</IonButton>
          </div>
        </div>

        <IonAlert
          isOpen={showAlert}
          onDidDismiss={() => setShowAlert(false)}
          header="Receipt Scanner"
          message={alertMessage}
          buttons={['OK']}
        />
      </IonContent>
    </IonPage>
  );
};

export default VerifyReceipt;
