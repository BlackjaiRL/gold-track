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
  const { lang, changeLang, t } = useLanguage();
  const backendBase = import.meta.env.VITE_API_BASE_URL.replace(/\/api$/, "");

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

  useEffect(() => {
    loadGoldPrice();
    loadItems();

    const interval = setInterval(() => {
      loadGoldPrice();
    }, 60000);

    return () => clearInterval(interval);
  }, []);

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

    if (buyPriceTotal === "" || Number(buyPriceTotal) < 0) {
      setMessage(t("Pleaseenteravalidbuyprice"));
      return;
    }

    try {
      setUploading(true);
      setMessage("Uploading item...");

      const formData = new FormData();
      formData.append("image", image);
      formData.append("grams", grams);
      formData.append("buyPriceTotal", buyPriceTotal);

      const token = localStorage.getItem("token");

      const response = await fetch("http://localhost:3000/api/items", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Upload failed");
      }

      setMessage("Item uploaded successfully");
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
      const itemBuyPriceTotal = Number(item.buy_price_total || 0);
      const currentValue = +(itemGrams * currentUsdPerGram).toFixed(2);
      const profitLoss = +(currentValue - itemBuyPriceTotal).toFixed(2);

      return {
        ...item,
        live_price_per_gram_usd: currentUsdPerGram,
        live_estimated_value_usd: currentValue,
        live_profit_loss: profitLoss,
      };
    });
  }, [items, goldData]);

  return (
    <div className="dashboard-page">
      <div className="topbar">
        <div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={() => changeLang("en")}>EN</button>
            <button onClick={() => changeLang("zh")}>中文</button>
          </div>
          <h1>{t("title")}</h1>
          <p>
            {t("welcome")}
            {user?.name ? `, ${user.name}` : ""}
          </p>
        </div>

        <button className="secondary-btn" onClick={onLogout}>
          {t("logout")}
        </button>
      </div>

      <div className="grid">
        <div className="card">
          <h2>{t("currentGoldPrice")}</h2>

          {loadingPrice ? (
            <p>{t("loadingPrice")}</p>
          ) : goldData ? (
            <>
              <p>
                <strong>XAU/USD:</strong> ${Number(goldData.xauUsd).toFixed(2)}
              </p>
              <p>
                <strong>{t("usdPerGram")}</strong> $
                {Number(goldData.usdPerGram).toFixed(2)}
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
              <label>{t("buyPrice")}</label>
              <input
                type="number"
                step="0.01"
                value={buyPriceTotal}
                onChange={(e) => setBuyPriceTotal(e.target.value)}
                placeholder="e.g. 1200"
                required
              />
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
                  src={`${backendBase}${item.image_path}`}
                  alt="Gold item"
                  className="item-image"
                />
                <div className="item-info">
                  <p>
                    <strong>{t("grams")}:</strong>{" "}
                    {Number(item.grams).toFixed(2)}
                  </p>

                  <p>
                    <strong>{t("buyPriceLabel")}:</strong> $
                    {Number(item.buy_price_total || 0).toFixed(2)}
                  </p>

                  <p>
                    <strong>{t("currentPrice")}:</strong> $
                    {Number(item.live_price_per_gram_usd || 0).toFixed(2)}
                  </p>

                  <p>
                    <strong>{t("currentValue")}:</strong> $
                    {Number(item.live_estimated_value_usd || 0).toFixed(2)}
                  </p>

                  <p>
                    <strong>{t("profitLoss")}:</strong>{" "}
                    <span
                      className={
                        Number(item.live_profit_loss) >= 0 ? "profit" : "loss"
                      }
                    >
                      ${Number(item.live_profit_loss || 0).toFixed(2)}
                    </span>
                  </p>

                  <button
                    className="delete-btn"
                    onClick={() => handleDelete(item.id)}
                  >
                    {t("delete")}
                  </button>

                  <p className="small-text">
                    {t("added")}: {new Date(item.created_at).toLocaleString()}
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
