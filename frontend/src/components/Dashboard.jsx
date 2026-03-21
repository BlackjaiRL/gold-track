import React, { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../api";
import useLanguage from "../useLanguage";

export default function Dashboard({ user, onLogout }) {
  const [goldData, setGoldData] = useState(null);
  const [items, setItems] = useState([]);
  const [grams, setGrams] = useState("");
  const [buyPriceTotal, setBuyPriceTotal] = useState("");
  const [image, setImage] = useState(null);
  const [message, setMessage] = useState("");
  const [loadingPrice, setLoadingPrice] = useState(false);
  const [loadingItems, setLoadingItems] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [rates, setRates] = useState({ USD: 1 });
  const [selectedCurrency, setSelectedCurrency] = useState("USD");
  const [loadingRates, setLoadingRates] = useState(false);

  const { changeLang, t } = useLanguage();
  const apiBase = import.meta.env.VITE_API_BASE_URL || "";

  async function loadGoldPrice() {
    try {
      setLoadingPrice(true);
      const data = await apiFetch("/gold/current");
      setGoldData(data);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoadingPrice(false);
    }
  }

  async function loadItems() {
    try {
      setLoadingItems(true);
      const data = await apiFetch("/items");
      setItems(data);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoadingItems(false);
    }
  }

  async function loadExchangeRates() {
    try {
      setLoadingRates(true);
      const response = await fetch("https://open.er-api.com/v6/latest/USD");
      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (!response.ok || data.result === "error") {
        throw new Error(data.error || "Failed to load exchange rates");
      }

      setRates({
        USD: 1,
        ...(data.rates || {}),
      });
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoadingRates(false);
    }
  }

  useEffect(() => {
    loadGoldPrice();
    loadItems();
    loadExchangeRates();

    const interval = setInterval(() => {
      loadGoldPrice();
      loadExchangeRates();
    }, 60000);

    return () => clearInterval(interval);
  }, []);

  const exchangeRate = Number(rates[selectedCurrency] || 1);

  function formatMoney(value, currency = selectedCurrency) {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(Number(value || 0));
  }

  async function handleUpload(e) {
    e.preventDefault();

    if (!image) {
      setMessage(t("Pleaseselectanimagetoupload"));
      return;
    }

    if (!grams || Number(grams) <= 0) {
      setMessage(t("Pleaseenteravalidgramsvalue"));
      return;
    }

    const enteredBuyPrice = Number(buyPriceTotal);

    if (!Number.isFinite(enteredBuyPrice) || enteredBuyPrice < 0) {
      setMessage(t("Pleaseenteravalidbuyprice"));
      return;
    }

    try {
      setUploading(true);
      setMessage(t("uploading"));

      const formData = new FormData();
      formData.append("image", image);
      formData.append("grams", grams);

      const buyPriceUsd = +(enteredBuyPrice / exchangeRate).toFixed(2);
      formData.append("buyPriceTotal", buyPriceUsd);

      const token = localStorage.getItem("token");

      const response = await apiFetch("/items", {
        method: "POST",
        body: formData,
      });

      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (!response.ok) {
        throw new Error(data.error || "Upload failed");
      }

      setMessage(t("uploadSuccess"));
      setGrams("");
      setBuyPriceTotal("");
      setImage(null);

      const imageInput = document.getElementById("imageInput");
      if (imageInput) {
        imageInput.value = "";
      }

      await loadItems();
      await loadGoldPrice();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(itemId) {
    const confirmDelete = window.confirm(t("confirmDelete"));
    if (!confirmDelete) return;

    try {
      setMessage(t("Deleting"));
      await apiFetch(`/items/${itemId}`, {
        method: "DELETE",
      });
      setMessage(t("deleted"));
      await loadItems();
    } catch (err) {
      setMessage(err.message);
    }
  }

  const enrichedItems = useMemo(() => {
    const currentUsdPerGram = Number(goldData?.usdPerGram || 0);

    return items.map((item) => {
      const itemGrams = Number(item.grams || 0);
      const itemBuyPriceUsd = Number(item.buyPriceTotal || 0);
      const currentValueUsd = +(itemGrams * currentUsdPerGram).toFixed(2);
      const profitLossUsd = +(currentValueUsd - itemBuyPriceUsd).toFixed(2);

      return {
        ...item,
        live_price_per_gram_usd: currentUsdPerGram,
        live_estimated_value_usd: currentValueUsd,
        live_profit_loss_usd: profitLossUsd,
        buy_price_converted: +(itemBuyPriceUsd * exchangeRate).toFixed(2),
        live_price_per_gram_converted: +(currentUsdPerGram * exchangeRate).toFixed(2),
        live_estimated_value_converted: +(currentValueUsd * exchangeRate).toFixed(2),
        live_profit_loss_converted: +(profitLossUsd * exchangeRate).toFixed(2),
      };
    });
  }, [items, goldData, exchangeRate]);

  const currencyOptions = useMemo(() => {
    return Object.keys(rates).sort();
  }, [rates]);

  return (
    <div className="dashboard-page">
      <div className="topbar">
        <div>
          <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
            <button onClick={() => changeLang("en")}>EN</button>
            <button onClick={() => changeLang("zh")}>中文</button>
          </div>

          <h1>{t("title")}</h1>
          <p>
            {t("welcome")}
            {user?.name ? `, ${user.name}` : ""}
          </p>
        </div>

        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <div>
            <label
              style={{
                display: "block",
                fontSize: "14px",
                marginBottom: "4px",
              }}
            >
              {t("currency")}
            </label>
            <select
              value={selectedCurrency}
              onChange={(e) => setSelectedCurrency(e.target.value)}
              disabled={loadingRates}
            >
              {currencyOptions.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>

          <button className="secondary-btn" onClick={onLogout}>
            {t("logout")}
          </button>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <h2>{t("currentGoldPrice")}</h2>

          {loadingPrice ? (
            <p>{t("loadingPrice")}</p>
          ) : goldData ? (
            <>
              <p>
                <strong>XAU/USD:</strong>{" "}
                {formatMoney(Number(goldData.xauUsd), "USD")}
              </p>

              <p>
                <strong>{t("usdPerGram")} (USD):</strong>{" "}
                {formatMoney(Number(goldData.usdPerGram), "USD")}
              </p>

              <p>
                <strong>
                  {t("currentPrice")} ({selectedCurrency}/g):
                </strong>{" "}
                {formatMoney(Number(goldData.usdPerGram || 0) * exchangeRate)}
              </p>

              <p>
                <strong>{t("updated")}:</strong>{" "}
                {new Date(goldData.updatedAt).toLocaleString()}
              </p>

              <p className="small-text">{t("autoRefresh")}</p>
            </>
          ) : (
            <p>No price data</p>
          )}
        </div>

        <div className="card">
          <h2>{t("uploadItem")}</h2>

          <form onSubmit={handleUpload} className="form">
            <div className="field">
              <label>{t("image")}</label>
              <input
                id="imageInput"
                type="file"
                accept="image/*"
                onChange={(e) => setImage(e.target.files?.[0] || null)}
                required
              />
            </div>

            <div className="field">
              <label>{t("grams")}</label>
              <input
                type="number"
                step="0.01"
                value={grams}
                onChange={(e) => setGrams(e.target.value)}
                placeholder="e.g. 12.5"
                required
              />
            </div>

            <div className="field">
              <label>
                {t("buyPrice")} ({selectedCurrency})
              </label>
              <input
                type="number"
                step="0.01"
                value={buyPriceTotal}
                onChange={(e) => setBuyPriceTotal(e.target.value)}
                placeholder={`e.g. ${selectedCurrency === "USD" ? "1200" : "1800"}`}
                required
              />
              <p className="small-text">
                {t("storedasUSD")}{" "}
                {formatMoney(
                  Number.isFinite(Number(buyPriceTotal))
                    ? Number(buyPriceTotal) / exchangeRate
                    : 0,
                  "USD"
                )}
              </p>
            </div>

            <button className="primary-btn" type="submit" disabled={uploading}>
              {uploading ? t("uploading") : t("upload")}
            </button>
          </form>
        </div>
      </div>

      <div className="card">
        <h2>{t("items")}</h2>

        {loadingItems ? (
          <p>{t("loadingItems")}</p>
        ) : enrichedItems.length === 0 ? (
          <p>{t("noItems")}</p>
        ) : (
          <div className="items-grid">
            {enrichedItems.map((item) => (
              <div key={item.id} className="item-card">
                <img
                  src={item.imagePath}
                  alt="Gold item"
                  className="item-image"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />

                <div className="item-info">
                  <p>
                    <strong>{t("grams")}:</strong>{" "}
                    {Number(item.grams).toFixed(2)}
                  </p>

                  <p>
                    <strong>{t("buyPriceLabel")}:</strong>{" "}
                    {formatMoney(item.buy_price_converted)}
                  </p>

                  <p className="small-text">
                    USD base: {formatMoney(item.buyPriceTotal || 0, "USD")}
                  </p>

                  <p>
                    <strong>{t("currentPrice")}:</strong>{" "}
                    {formatMoney(item.live_price_per_gram_converted)}
                  </p>

                  <p>
                    <strong>{t("currentValue")}:</strong>{" "}
                    {formatMoney(item.live_estimated_value_converted)}
                  </p>

                  <p>
                    <strong>{t("profitLoss")}:</strong>{" "}
                    <span
                      className={
                        Number(item.live_profit_loss_converted) >= 0
                          ? "profit"
                          : "loss"
                      }
                    >
                      {formatMoney(item.live_profit_loss_converted)}
                    </span>
                  </p>

                  <button
                    className="delete-btn"
                    onClick={() => handleDelete(item.id)}
                  >
                    {t("delete")}
                  </button>

                  <p className="small-text">
                    {t("added")}: {new Date(item.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {message && <p className="message dashboard-message">{message}</p>}
    </div>
  );
}