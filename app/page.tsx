"use client";

import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { Studio } from "@/components/Studio";

export default function Page() {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        window.location.href = "/login.html";
      } else {
        setChecked(true);
      }
    });
  }, []);

  if (!checked) return null;
  return <Studio />;
}
