<?php
// Получаем ссылку на кассу из параметра
if (isset($_GET['link'])) {
    $anypay_url = urldecode($_GET['link']);
    
    // Защита: проверяем, что ссылка действительно ведет на AnyPay
    if (strpos($anypay_url, 'https://anypay.io/') === 0) {
        // Делаем редирект
        header("Location: " . $anypay_url);
        exit;
    }
}

// Если что-то пошло не так, просто кидаем на главную страницу белого сайта
header("Location: /");
exit;
?>
