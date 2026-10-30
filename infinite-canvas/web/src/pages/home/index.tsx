import { ArrowRight, Images } from "lucide-react";
import { Button } from "antd";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

export default function IndexPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();

    return (
        <main className="relative h-full overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] text-stone-950 dark:bg-[radial-gradient(rgba(245,245,244,.18)_1px,transparent_1px)] dark:text-stone-100">
            <section className="relative mx-auto min-h-[calc(100vh-4rem)] max-w-7xl overflow-hidden px-6">
                <div className="pointer-events-none absolute left-[15%] top-24 size-20 rounded-full border border-dashed border-stone-200 dark:border-stone-800" />
                <div className="pointer-events-none absolute right-[23%] top-[48%] size-20 rounded-full border border-dashed border-stone-200 dark:border-stone-800" />

                <div className="relative flex min-h-[620px] flex-col items-center justify-center pt-10 text-center">
                    <h1 className="ai-title-aurora max-w-5xl text-balance text-5xl font-semibold tracking-normal sm:text-7xl lg:text-8xl">{t("meta.title")}</h1>
                    <p className="mt-5 max-w-xl text-base leading-7 text-stone-500 dark:text-stone-400">{t("meta.description")}</p>
                    <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
                        <Button type="primary" size="large" onClick={() => navigate("/canvas")} icon={<ArrowRight className="size-4" />} iconPlacement="end">
                            {t("home.openCanvas")}
                        </Button>
                        <Button size="large" onClick={() => navigate("/assets")} icon={<Images className="size-4" />}>
                            {t("navigation.assets")}
                        </Button>
                    </div>
                </div>
            </section>
        </main>
    );
}
