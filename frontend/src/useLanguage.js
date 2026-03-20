import { useState } from "react";
import { translations } from "./i18n";

export default function useLanguage() {
  const [lang, setLang] = useState(
    localStorage.getItem("lang") || "en"
  );

  function changeLang(newLang) {
    setLang(newLang);
    localStorage.setItem("lang", newLang);
  }

  function t(key) {
    return translations[lang][key] || key;
  }

  return { lang, changeLang, t };
}